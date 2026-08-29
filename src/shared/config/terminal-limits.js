/**
 * Single source of truth for terminal count limits.
 * Used by the desktop runtime, renderer, mobile runtime and tests — never hardcode these numbers.
 */

// Absolute technical maximum of simultaneous terminals (0-based quadrants 0..MAX_TERMINALS-1)
const MAX_TERMINALS = 50;

// Business limits per subscription tier (the tier system is scheduled for removal;
// when that happens this collapses to MAX_TERMINALS only)
const TERMINAL_LIMITS_BY_TIER = {
    free: 2,
    starter: 4,
    pro: MAX_TERMINALS
};

// Above this count the grid becomes hard to read on laptop screens;
// the UI suggests tabbed mode beyond it
const GRID_RECOMMENDED_MAX = 9;

// Terminals a cold, empty boot opens for you. Fits every tier (free allows 2).
const DEFAULT_BOOT_TERMINALS = 2;

module.exports = { MAX_TERMINALS, TERMINAL_LIMITS_BY_TIER, GRID_RECOMMENDED_MAX, DEFAULT_BOOT_TERMINALS };
