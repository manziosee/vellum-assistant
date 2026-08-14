/**
 * Tests for the guardian request reminder sweep.
 *
 * Verifies:
 * 1. runGuardianReminderSweep fetches pending-for-reminder rows, marks them
 *    as reminded, and attempts channel delivery.
 * 2. Delivery is skipped for channels that cannot address the guardian by
 *    user ID (Telegram, WhatsApp); followupState is still marked.
 * 3. Slack and Discord DM delivery is attempted with the guardian's user ID.
 * 4. A gateway failure in the initial fetch is logged and returns 0 (skip-round).
 * 5. A failure to mark followupState skips delivery to avoid double-remind risk.
 * 6. A failed channel delivery is non-fatal (state is already marked).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Delivery sink - captures replies sent via the deliver route.
const deliveredReplies: Array<{
  url: string;
  payload: { chatId: string; text: string; assistantId?: string };
}> = [];
let deliveryError: Error | null = null;
mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    url: string,
    payload: { chatId: string; text: string; assistantId?: string },
  ) => {
    if (deliveryError) {
      throw deliveryError;
    }
    deliveredReplies.push({ url, payload });
  },
}));

// In-memory guardian request store shared across mock implementations.
interface MockRow {
  row: GuardianRequestWire;
  followupState: string | null;
}
const requestStore = new Map<string, MockRow>();
let gatewayFetchError: Error | null = null;
let updateError: Error | null = null;

mock.module("../channels/gateway-guardian-requests.js", () => ({
  sweepPendingGuardianRequestsForReminders: async () => {
    if (gatewayFetchError) {
      throw gatewayFetchError;
    }
    return [...requestStore.values()].map((s) => s.row);
  },
  updateGuardianRequest: async (
    id: string,
    patch: { followupState?: string | null },
  ) => {
    if (updateError) {
      throw updateError;
    }
    const entry = requestStore.get(id);
    if (entry && patch.followupState !== undefined) {
      entry.followupState = patch.followupState;
    }
  },
}));

import type { GuardianRequestWire } from "../channels/gateway-guardian-requests.js";
import { runGuardianReminderSweep } from "../runtime/routes/guardian-reminder-sweep.js";

/** Build a wire request fixture. */
function makeRequest(
  overrides: Partial<GuardianRequestWire> & { kind: string },
): GuardianRequestWire {
  return {
    id: "req-1",
    sourceType: "channel",
    sourceChannel: "slack",
    sourceConversationId: "conv-1",
    requesterExternalUserId: "req-user",
    requesterChatId: "req-chat",
    requestTrigger: null,
    guardianExternalUserId: "G-guardian-user",
    guardianPrincipalId: "guardian-principal",
    callSessionId: null,
    pendingQuestionId: null,
    questionText: null,
    requestCode: "ABC123",
    toolName: null,
    inputDigest: null,
    commandPreview: null,
    riskLevel: null,
    activityText: null,
    executionTarget: null,
    requesterSignals: null,
    status: "pending",
    answerText: null,
    decidedByExternalUserId: null,
    decidedByPrincipalId: null,
    followupState: null,
    expiresAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function seedRequest(
  overrides: Partial<GuardianRequestWire> & { kind: string },
): GuardianRequestWire {
  const row = makeRequest(overrides);
  requestStore.set(row.id, { row, followupState: null });
  return row;
}

beforeEach(() => {
  deliveredReplies.length = 0;
  requestStore.clear();
  deliveryError = null;
  gatewayFetchError = null;
  updateError = null;
});

describe("runGuardianReminderSweep", () => {
  test("returns 0 and skips when no requests are due", async () => {
    const count = await runGuardianReminderSweep();
    expect(count).toBe(0);
    expect(deliveredReplies).toHaveLength(0);
  });

  test("marks followupState = 'reminded' before attempting delivery", async () => {
    const req = seedRequest({ kind: "access_request", sourceChannel: "slack" });
    await runGuardianReminderSweep();
    expect(requestStore.get(req.id)?.followupState).toBe("reminded");
  });

  test("Slack access_request: sends DM to guardian's user ID", async () => {
    seedRequest({
      id: "req-slack",
      kind: "access_request",
      sourceChannel: "slack",
      guardianExternalUserId: "UGUARDIAN",
      requestCode: "XYZ789",
    });

    await runGuardianReminderSweep();

    expect(deliveredReplies).toHaveLength(1);
    expect(deliveredReplies[0].url).toBe("/deliver/slack");
    expect(deliveredReplies[0].payload.chatId).toBe("UGUARDIAN");
    expect(deliveredReplies[0].payload.text).toContain("access request");
    expect(deliveredReplies[0].payload.text).toContain("XYZ789");
  });

  test("Discord tool_grant_request: sends DM to guardian's user ID", async () => {
    seedRequest({
      id: "req-discord",
      kind: "tool_grant_request",
      sourceChannel: "discord",
      guardianExternalUserId: "12345678",
      toolName: "bash",
      requestCode: "TL1234",
    });

    await runGuardianReminderSweep();

    expect(deliveredReplies).toHaveLength(1);
    expect(deliveredReplies[0].url).toContain("/deliver/discord");
    expect(deliveredReplies[0].payload.chatId).toBe("12345678");
    expect(deliveredReplies[0].payload.text).toContain('"bash"');
    expect(deliveredReplies[0].payload.text).toContain("TL1234");
  });

  test("Telegram channel: skips delivery (no DM-by-user-id), still marks reminded", async () => {
    const req = seedRequest({
      kind: "access_request",
      sourceChannel: "telegram",
      guardianExternalUserId: "tg-guardian",
    });

    await runGuardianReminderSweep();

    // State marked, but no channel delivery since Telegram lacks user-id DM
    expect(requestStore.get(req.id)?.followupState).toBe("reminded");
    expect(deliveredReplies).toHaveLength(0);
  });

  test("WhatsApp channel: skips delivery, still marks reminded", async () => {
    const req = seedRequest({
      kind: "tool_grant_request",
      sourceChannel: "whatsapp",
      guardianExternalUserId: "+250780000000",
    });

    await runGuardianReminderSweep();

    expect(requestStore.get(req.id)?.followupState).toBe("reminded");
    expect(deliveredReplies).toHaveLength(0);
  });

  test("missing guardianExternalUserId: skips delivery, still marks reminded", async () => {
    const req = seedRequest({
      kind: "access_request",
      sourceChannel: "slack",
      guardianExternalUserId: null,
    });

    await runGuardianReminderSweep();

    expect(requestStore.get(req.id)?.followupState).toBe("reminded");
    expect(deliveredReplies).toHaveLength(0);
  });

  test("gateway fetch failure: logs and returns 0, no deliveries", async () => {
    seedRequest({ kind: "access_request" });
    gatewayFetchError = new Error("gateway down");

    const count = await runGuardianReminderSweep();

    expect(count).toBe(0);
    expect(deliveredReplies).toHaveLength(0);
  });

  test("update failure: skips delivery to avoid double-remind", async () => {
    const req = seedRequest({ kind: "access_request", sourceChannel: "slack" });
    updateError = new Error("db locked");

    await runGuardianReminderSweep();

    // followupState not flipped since the update threw
    expect(requestStore.get(req.id)?.followupState).toBeNull();
    // delivery must NOT proceed either
    expect(deliveredReplies).toHaveLength(0);
  });

  test("delivery failure is non-fatal; state remains marked", async () => {
    const req = seedRequest({ kind: "access_request", sourceChannel: "slack" });
    deliveryError = new Error("slack 503");

    const count = await runGuardianReminderSweep();

    expect(count).toBe(1);
    expect(requestStore.get(req.id)?.followupState).toBe("reminded");
  });

  test("returns the count of reminded requests", async () => {
    seedRequest({ id: "req-a", kind: "access_request" });
    seedRequest({ id: "req-b", kind: "tool_grant_request" });

    const count = await runGuardianReminderSweep();

    expect(count).toBe(2);
  });
});
