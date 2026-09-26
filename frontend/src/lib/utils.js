import { clsx } from "clsx";
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

/**
 * Safely parses any value into a finite number.
 * Returns the fallback (default 0) if the value is null, undefined, NaN, or non-numeric.
 */
export function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Safely formats any numeric value to a fixed number of decimal places without throwing.
 */
export function safeFixed(value, digits = 2, fallback = 0) {
  return safeNumber(value, fallback).toFixed(digits);
}

