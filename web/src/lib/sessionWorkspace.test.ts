import { beforeEach, describe, expect, it } from "vitest";
import type { Membership } from "@/lib/api/types";
import { pickWorkspace } from "./session";

const ms = (...ids: string[]) => ids.map((id) => ({ workspace: { id }, role: "admin" }) as unknown as Membership);

describe("pickWorkspace", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("takes the browser's last workspace for a new tab", () => {
    localStorage.setItem("od-ws:u1", "b");
    expect(pickWorkspace("u1", ms("a", "b"))).toBe("b");
  });

  it("keeps this tab's workspace when another tab switched", () => {
    sessionStorage.setItem("od-ws:u1", "b");
    localStorage.setItem("od-ws:u1", "a");
    expect(pickWorkspace("u1", ms("a", "b"))).toBe("b");
  });

  it("falls back when the remembered workspace is gone", () => {
    sessionStorage.setItem("od-ws:u1", "gone");
    localStorage.setItem("od-ws:u1", "b");
    expect(pickWorkspace("u1", ms("a", "b"))).toBe("b");
    expect(pickWorkspace("u2", ms("a", "b"))).toBe("a");
  });

  it("prefers an explicit workspace", () => {
    sessionStorage.setItem("od-ws:u1", "b");
    expect(pickWorkspace("u1", ms("a", "b"), "a")).toBe("a");
  });
});
