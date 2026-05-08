import type { Speaker } from "../types";

// Two-color gradients used by the kiosk avatars / orb cores. Stable order so
// each user_id deterministically maps to one palette across sessions.
const PALETTE: Array<[string, string]> = [
  ["#7ef0ff", "#3da9fc"],
  ["#bff4ff", "#3da9fc"],
  ["#7ef0ff", "#1a3a6e"],
  ["#6affc8", "#3da9fc"],
  ["#ffd577", "#3da9fc"],
  ["#ff7aa8", "#3da9fc"],
];

export type Profile = Speaker & {
  id: string;       // alias for userId — the prototype expects { id }
  name: string;     // display name; falls back to userId
  initials: string;
  color1: string;
  color2: string;
};

export function deriveProfile(speaker: Speaker): Profile {
  const userId = speaker.userId;
  const initials = computeInitials(userId);
  const [color1, color2] = PALETTE[stableIndex(userId, PALETTE.length)];
  return {
    ...speaker,
    id: userId,
    name: userId,
    initials,
    color1,
    color2,
  };
}

function computeInitials(userId: string): string {
  const parts = userId.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return userId.slice(0, 2).toUpperCase();
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2);
}

function stableIndex(input: string, mod: number): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash % mod;
}
