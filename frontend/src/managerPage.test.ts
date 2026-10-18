// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { managerPageFromPath, navigateManagerPage } from "./managerPage";

afterEach(() => { window.history.replaceState(null, "", "/"); });

describe("manager pages", () => {
  it("recognizes the teardown path on direct load, including a trailing slash", () => {
    expect(managerPageFromPath("/teardown")).toBe("teardown");
    expect(managerPageFromPath("/teardown/")).toBe("teardown");
    expect(managerPageFromPath("/")).toBe("home");
  });

  it("opens teardown and returns home while preserving the query string", () => {
    window.history.replaceState(null, "", "/?context=commander%2F1");
    navigateManagerPage("teardown");
    expect(window.location.pathname).toBe("/teardown");
    expect(window.location.search).toBe("?context=commander%2F1");
    navigateManagerPage("home", "replace");
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?context=commander%2F1");
  });
});
