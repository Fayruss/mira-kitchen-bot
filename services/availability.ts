// availability.ts
// Responsibility: know whether the kitchen is open, and let it be
// toggled. Backed by a single row in the `availability` table.

import { getSupabaseClient } from "@/lib/supabase";

const TABLE = "availability";
const ROW_ID = 1; // single row holds the current OPEN/CLOSED flag

async function setIsOpen(isOpen: boolean): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from(TABLE)
    .upsert({ id: ROW_ID, is_open: isOpen, updated_at: new Date().toISOString() });

  if (error) {
    throw new Error(`Failed to update availability: ${error.message}`);
  }
}

export async function isKitchenOpen(): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from(TABLE)
    .select("is_open")
    .eq("id", ROW_ID)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read availability: ${error.message}`);
  }

  // Default to open if the row hasn't been created yet.
  return data ? data.is_open : true;
}

export async function openKitchen(): Promise<void> {
  await setIsOpen(true);
}

export async function closeKitchen(): Promise<void> {
  await setIsOpen(false);
}
