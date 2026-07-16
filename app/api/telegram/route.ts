import { NextRequest, NextResponse } from "next/server";
import { parseUpdate, sendMessage } from "@/services/telegram";
import { getOrCreateSession, addMessageToHistory, saveSession } from "@/services/sessions";
import { routeConversation } from "@/services/conversation";

// This route makes several sequential network calls per request (Supabase
// reads/writes, Telegram sendMessage, sometimes another Telegram call for
// the admin notification). 10s covers that comfortably; raise it if a
// Vercel plan allows more and latency ever gets close.
export const maxDuration = 10;

// Receives Telegram webhook updates.
// Parses the update, loads (or creates) the session from Supabase,
// routes the message through the Conversation Engine (AI-assisted slot
// filling backed by Gemini, with the state machine kept as bookkeeping
// — see services/conversation.ts), saves the session, and sends back
// the resulting reply.
//
// Always resolves with 200 OK, even when something inside fails. Telegram
// retries webhook deliveries that don't get a 2xx response, and retried
// updates would replay whatever state-changing side effects already ran
// (duplicate order saves, duplicate admin notifications, repeated
// replies). Returning 200 unconditionally and logging failures instead
// keeps a single glitch from turning into a retry storm.
export async function POST(req: NextRequest) {
  try {
    const update = await req.json();
    const message = parseUpdate(update);

    if (message) {
      const session = await getOrCreateSession(message.chatId);
      addMessageToHistory(session, message.text);

      const reply = await routeConversation(session, message.text);
      await saveSession(session);

      await sendMessage(message.chatId, reply);
    }
  } catch (error) {
    console.error("Failed to process Telegram update:", error);
  }

  return NextResponse.json({ ok: true });
}
