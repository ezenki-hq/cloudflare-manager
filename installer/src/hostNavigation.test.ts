// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reloadCommanderHost } from "./hostNavigation";

beforeEach(() => sessionStorage.clear());

describe("installer host navigation", () => {
  it("reloads once for each run key", () => {
    const reload = vi.fn();
    expect(reloadCommanderHost("manager", "install", "run", reload)).toBe(true);
    expect(reloadCommanderHost("manager", "install", "run", reload)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
  it("clears the marker when reload is blocked so it can be retried", () => {
    const reload = vi.fn().mockImplementationOnce(() => { throw new Error("blocked"); });
    expect(reloadCommanderHost("manager", "teardown", "run", reload)).toBe(false);
    expect(reloadCommanderHost("manager", "teardown", "run", reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
