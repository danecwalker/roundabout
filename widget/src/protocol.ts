// Messages between the widget frame and the host page.

export type FrameEvent =
  | { type: "ready" }
  | { type: "mode"; mode: "managed" | "non_interactive" | "invisible" }
  | { type: "interactive" }
  | { type: "interactive_done" }
  | { type: "timeout" }
  | { type: "success"; token: string; expiresIn: number; clearance?: { value: string; maxAge: number } }
  | { type: "error"; code: string };

export type FrameMessage = FrameEvent & { __roundabout: 1; wid: string };

/** Host → frame. */
export type HostMessage = { __roundabout: 1; type: "execute" };
