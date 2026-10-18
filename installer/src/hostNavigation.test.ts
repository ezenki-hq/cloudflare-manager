// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reloadCurrentInterface } from "./hostNavigation";

beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe("installer local navigation", () => {
  it("reloads once for each run key", () => {
    const reload = vi.fn();
    expect(reloadCurrentInterface("manager", "install", "run", reload)).toBe(true);
    expect(reloadCurrentInterface("manager", "install", "run", reload)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
  it("clears the marker when reload is blocked so it can be retried", () => {
    const reload = vi.fn().mockImplementationOnce(() => { throw new Error("blocked"); });
    expect(reloadCurrentInterface("manager", "teardown", "run", reload)).toBe(false);
    expect(reloadCurrentInterface("manager", "teardown", "run", reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it("does not reload automatically when it cannot store the loop guard", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage disabled"); });
    const reload = vi.fn();
    expect(reloadCurrentInterface("manager", "install", "run", reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
