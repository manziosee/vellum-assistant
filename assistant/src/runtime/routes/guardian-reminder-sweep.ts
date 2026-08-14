/**
 * Guardian request reminder sweep.
 *
 * Periodically checks for persistent pending guardian requests
 * (`access_request`, `tool_grant_request`) that have been waiting longer than
 * REMINDER_THRESHOLD_MS without any followup, and sends a reminder text to the
 * guardian so requests are not silently forgotten.
 *
 * The gateway query is intentionally read-only - it returns rows due for a
 * reminder without mutating them. The daemon then, for each row:
 *   1. Marks followupState = 'reminded' via updateGuardianRequest (fail-safe:
 *      prevents double-reminding even if delivery fails).
 *   2. Attempts to deliver a reminder text to the guardian's channel.
 *
 * Channels where the guardian cannot be individually addressed (Telegram,
 * WhatsApp) skip delivery; the followupState is still marked so the request
 * is not re-queried on the next sweep.
 *
 * Unreachable-gateway posture: log and skip the round.
 */

import {
  channelDeliversToUserId,
  resolveDeliverCallbackUrlForChannel,
} from "../../approvals/guardian-channel-delivery.js";
import {
  type GuardianRequestWire,
  sweepPendingGuardianRequestsForReminders,
  updateGuardianRequest,
} from "../../channels/gateway-guardian-requests.js";
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { deliverChannelReply } from "../gateway-client.js";

const log = getLogger("guardian-reminder-sweep");

/** Requests pending longer than this without a followupState get a reminder. */
const REMINDER_THRESHOLD_MS = 10 * 60 * 1000;

/** Interval at which the reminder sweep runs (60 seconds). */
const SWEEP_INTERVAL_MS = 60_000;

/** Timer handle for the sweep so it can be stopped in tests and shutdown. */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Guard against overlapping sweeps. */
let sweepInProgress = false;

/**
 * Run one reminder sweep round: fetch pending requests due for a reminder,
 * mark each as reminded, then attempt channel delivery. Returns the count of
 * requests reminded.
 */
export async function runGuardianReminderSweep(): Promise<number> {
  let pending: GuardianRequestWire[];
  try {
    pending = await sweepPendingGuardianRequestsForReminders(
      REMINDER_THRESHOLD_MS,
    );
  } catch (err) {
    log.warn(
      { err },
      "Guardian reminder sweep skipped - gateway unreachable; next round retries",
    );
    return 0;
  }

  for (const request of pending) {
    log.info(
      {
        event: "guardian_request_reminder_due",
        requestId: request.id,
        kind: request.kind,
        createdAt: request.createdAt,
      },
      "Guardian request pending without action - sending reminder",
    );

    // Mark reminded first (fail-safe: prevents double-reminding regardless of
    // whether the channel delivery below succeeds).
    try {
      await updateGuardianRequest(request.id, { followupState: "reminded" });
    } catch (err) {
      log.warn(
        { err, requestId: request.id },
        "Failed to mark guardian request as reminded - skipping delivery to avoid double-remind risk",
      );
      continue;
    }

    await deliverReminderToGuardian(request);
  }

  if (pending.length > 0) {
    log.info(
      {
        event: "guardian_reminder_sweep_complete",
        remindedCount: pending.length,
      },
      `Guardian reminder sweep: sent ${pending.length} reminder(s)`,
    );
  }

  return pending.length;
}

/**
 * Attempt to deliver a reminder text to the guardian on their channel.
 * Only channels that support DM delivery by user ID (Slack, Discord) are
 * attempted; all others skip silently (followupState is already marked).
 * Best-effort and non-throwing.
 */
async function deliverReminderToGuardian(
  request: GuardianRequestWire,
): Promise<void> {
  const channel = request.sourceChannel ?? "";
  const guardianUserId = request.guardianExternalUserId;

  if (!guardianUserId || !channelDeliversToUserId(channel)) {
    return;
  }

  const deliverUrl = resolveDeliverCallbackUrlForChannel(channel);
  if (!deliverUrl) {
    return;
  }

  const text = buildReminderText(request);

  try {
    await deliverChannelReply(deliverUrl, {
      chatId: guardianUserId,
      text,
      assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    });
    log.info(
      { requestId: request.id, kind: request.kind, channel },
      "Delivered guardian request reminder",
    );
  } catch (err) {
    log.warn(
      { err, requestId: request.id, channel },
      "Failed to deliver guardian request reminder (non-fatal - state already marked)",
    );
  }
}

/** Build a brief reminder message for the given request kind. */
function buildReminderText(request: GuardianRequestWire): string {
  const code = request.requestCode ? ` (code: ${request.requestCode})` : "";
  switch (request.kind) {
    case "access_request":
      return (
        `Reminder: you have an unreviewed access request${code}. ` +
        "Reply with the request code to approve or deny."
      );
    case "tool_grant_request": {
      const tool = request.toolName ? ` for "${request.toolName}"` : "";
      return (
        `Reminder: you have an unreviewed tool grant request${tool}${code}. ` +
        "Reply with the request code to approve or deny."
      );
    }
    default:
      return `Reminder: you have an unreviewed pending request${code}.`;
  }
}

/**
 * Start the periodic guardian reminder sweep. Idempotent - calling it
 * multiple times reuses the same timer.
 */
export function startGuardianReminderSweep(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    if (sweepInProgress) {
      return;
    }
    sweepInProgress = true;
    void runGuardianReminderSweep()
      .catch((err) => {
        log.error({ err }, "Guardian reminder sweep failed");
      })
      .finally(() => {
        sweepInProgress = false;
      });
  }, SWEEP_INTERVAL_MS);
}

/**
 * Stop the periodic guardian reminder sweep. Used in tests and shutdown.
 */
export function stopGuardianReminderSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sweepInProgress = false;
}
