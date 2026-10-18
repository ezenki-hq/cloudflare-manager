// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reloadCommanderHost } from "./hostNavigation";

beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe("reloadCommanderHost", () => {
  it("reloads once per manager, action, and run", () => {
    const reload = vi.fn();
    expect(reloadCommanderHost("m", "install", "r", reload)).toBe(true);
    expect(reloadCommanderHost("m", "install", "r", reload)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
  it("allows retry when reload throws", () => {
    const reload = vi.fn().mockImplementationOnce(() => { throw new Error("blocked"); });
    expect(reloadCommanderHost("m", "teardown", "r", reload)).toBe(false);
    expect(reloadCommanderHost("m", "teardown", "r", reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it("does not reload automatically when it cannot store the loop guard", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage disabled"); });
    const reload = vi.fn();
    expect(reloadCommanderHost("m", "install", "r", reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
