// orders.ts
// Responsibility: save a completed order into the orders table, and
// notify the admin (ADMIN_CHAT_ID) on Telegram when a new order comes in.

import { getSupabaseClient } from "@/lib/supabase";
import { getAdminChatId } from "@/lib/env";
import { sendMessage } from "./telegram";

export type NewOrder = {
  chatId: number;
  customerName: string;
  deliveryArea: string;
  items: string;
  quantity: string;
};

export async function saveOrder(order: NewOrder): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from("orders").insert({
    chat_id: order.chatId,
    customer_name: order.customerName,
    delivery_area: order.deliveryArea,
    items: order.items,
    quantity: order.quantity,
  });

  if (error) {
    throw new Error(`Failed to save order: ${error.message}`);
  }
}

function formatOrderMessage(order: NewOrder): string {
  const timestamp = new Date().toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return [
    "🍽️ New Order",
    "",
    `Name: ${order.customerName}`,
    `Area: ${order.deliveryArea}`,
    `Items: ${order.items}`,
    `Quantity: ${order.quantity}`,
    "",
    timestamp,
  ].join("\n");
}

// Sends a formatted new-order notification to ADMIN_CHAT_ID. Never
// throws — a Telegram or config problem here should not stop the
// customer's order from having been saved and confirmed.
export async function notifyAdmin(order: NewOrder): Promise<void> {
  const adminChatId = getAdminChatId();

  if (adminChatId === null) {
    console.error("Cannot notify admin: ADMIN_CHAT_ID is not set or invalid");
    return;
  }

  try {
    await sendMessage(adminChatId, formatOrderMessage(order));
  } catch (error) {
    console.error("Failed to notify admin of new order:", error);
  }
}
