// menu.ts
// Responsibility: read and manage the menu in Supabase.
// No admin dashboard — everything here is driven by Telegram admin
// commands (/menu, /additem, /edititem, /removeitem in
// services/conversation.ts) or, previously, direct edits in Supabase.

import { getSupabaseClient } from "@/lib/supabase";

const TABLE = "menu_items";

export type MenuItem = {
  id: string;
  name: string;
  price: number;
  available: boolean;
};

// Returns every menu item, alphabetically by name, for both display
// (/menu) and selection (/edititem, /removeitem).
export async function listMenuItems(): Promise<MenuItem[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from(TABLE)
    .select("id, name, price, available")
    .order("name", { ascending: true });

  if (error) {
    throw new Error(`Failed to load menu: ${error.message}`);
  }

  return (data ?? []) as MenuItem[];
}

export async function addMenuItem(name: string, price: number, available: boolean): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from(TABLE).insert({ name, price, available });

  if (error) {
    throw new Error(`Failed to add menu item: ${error.message}`);
  }
}

export async function updateMenuItem(
  id: string,
  updates: Partial<{ name: string; price: number; available: boolean }>
): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from(TABLE).update(updates).eq("id", id);

  if (error) {
    throw new Error(`Failed to update menu item: ${error.message}`);
  }
}

export async function deleteMenuItem(id: string): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from(TABLE).delete().eq("id", id);

  if (error) {
    throw new Error(`Failed to delete menu item: ${error.message}`);
  }
}

export async function getMenuText(): Promise<string> {
  const items = await listMenuItems();

  if (items.length === 0) {
    return "The menu is currently empty.";
  }

  const lines = items.map((item) => {
    const status = item.available ? "" : " (unavailable)";
    return `- ${item.name}: $${item.price}${status}`;
  });

  return ["Current menu:", ...lines].join("\n");
}
