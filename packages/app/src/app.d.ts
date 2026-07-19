import type { SessionUser } from "$lib/server/auth";

declare global {
  namespace App {
    interface Locals {
      user: SessionUser | null;
    }
    interface Error {
      message: string;
      /** Correlation id for an unhandled server error (set by handleError); shown to the user to quote in a report. */
      errorId?: string;
    }
    interface PageData {
      /** Set by the full-bleed artifact viewer so the layout drops portal chrome. */
      fullBleed?: boolean;
    }
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
