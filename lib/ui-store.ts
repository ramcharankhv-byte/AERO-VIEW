'use client';

import { create } from 'zustand';

/**
 * Chrome state: which panels are open, where the sheet is parked.
 *
 * WHY THIS IS NOT PART OF useViewStore
 * ------------------------------------
 * lib/url-state.ts subscribes to every useViewStore change and schedules a
 * rAF to recompute the query string. More importantly, that module states the
 * rule plainly: only DELIBERATE state is serialised, and transient interface
 * state stays out. Whether a drawer happens to be open is exactly the second
 * category -- it describes this browser window, not the view being shared.
 *
 * Keeping it in its own store honours that rule structurally instead of
 * relying on url-state's whitelist to keep quietly dropping it.
 */

/** How far the compact bottom sheet is pulled up. */
export type SheetSnap = 'peek' | 'half' | 'full';

/**
 * Which tab the sheet is showing.
 *
 * NEVER give these numeric labels. verify_ui.mjs finds floor-ladder rungs by
 * matching any button whose trimmed innerText is /^(G|[0-9]{1,2}|B[0-9])$/ and
 * prefers the one reading exactly '2'; a tab labelled with a bare number would
 * hijack that selector and the floor test would drive the wrong control.
 */
export type SheetTab = 'detail' | 'layers' | 'key' | 'stats';

export interface UiState {
  /** Medium regime: the off-canvas layer panel. */
  drawerOpen: boolean;
  /** Compact regime: bottom-sheet position and tab. */
  sheetSnap: SheetSnap;
  sheetTab: SheetTab;

  setDrawerOpen: (open: boolean) => void;
  toggleDrawer: () => void;
  setSheetSnap: (snap: SheetSnap) => void;
  setSheetTab: (tab: SheetTab) => void;
  /**
   * Bring the detail tab into view after a selection.
   *
   * One action rather than setSheetTab + setSheetSnap at the call site,
   * because publishing an intermediate state (detail tab, still peeking) makes
   * the sheet visibly jump twice for a single tap. It never LOWERS the sheet:
   * a user who has pulled it to full has said what they want to see.
   */
  revealDetail: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  drawerOpen: false,
  sheetSnap: 'peek',
  sheetTab: 'detail',

  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  setSheetSnap: (sheetSnap) => set({ sheetSnap }),
  setSheetTab: (sheetTab) => set({ sheetTab }),

  revealDetail: () =>
    set((s) => ({
      sheetTab: 'detail',
      sheetSnap: s.sheetSnap === 'peek' ? 'half' : s.sheetSnap,
    })),
}));

/**
 * Sheet height at each snap.
 *
 * `peek` has to clear the 20px handle plus the ~40px tab bar AND still show a
 * line of the panel behind it -- at 104px it showed the tabs and nothing else,
 * which makes the sheet look broken rather than collapsed.
 */
export const SHEET_HEIGHT: Record<SheetSnap, string> = {
  peek: '140px',
  half: '50dvh',
  full: '88dvh',
};
