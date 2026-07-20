// orders.ts
// Responsibility: save a completed order into the orders table, notify
// every configured admin on Telegram when a new order comes in, and let
// admins list recent orders.

import { getSupabaseClient } from "@/lib/supabase";
import { getAdminChatIds } from "@/lib/env";
import { sendMessage } from "./telegram";

export type NewOrder = {
  chatId: number;
  customerName: string;
  deliveryArea: string;
  items: string;
  quantity: string;
};

export type OrderRecord = {
  id: string;
  chatId: number;
  customerName: string;
  deliveryArea: string;
  items: string;
  quantity: string;
  createdAt: string;
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

// Most recent orders first, for the admin "Recent Orders" view. Reads
// the existing orders table — no schema change.
export async function listRecentOrders(limit = 10): Promise<OrderRecord[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("orders")
    .select("id, chat_id, customer_name, delivery_area, items, quantity, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load recent orders: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    customerName: row.customer_name,
    deliveryArea: row.delivery_area,
    items: row.items,
    quantity: row.quantity,
    createdAt: row.created_at,
  }));
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

// Sends a formatted new-order notification to every configured admin
// (ADMIN_IDS, or the legacy single ADMIN_CHAT_ID). Never throws — a
// Telegram or config problem here should not stop the customer's order
// from having been saved and confirmed, and one admin's chat failing to
// receive it should not stop the others from getting notified.
export async function notifyAdmin(order: NewOrder): Promise<void> {
  const adminChatIds = getAdminChatIds();

  if (adminChatIds.length === 0) {
    console.error("Cannot notify admin: no ADMIN_IDS/ADMIN_CHAT_ID configured");
    return;
  }

  const message = formatOrderMessage(order);

  await Promise.all(
    adminChatIds.map(async (chatId) => {
      try {
        await sendMessage(chatId, message);
      } catch (error) {
        console.error(`Failed to notify admin ${chatId} of new order:`, error);
      }
    })
  );
}
