// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { GitPullRequestIcon } from "../../shared/design-system/icons";
import { presentPull } from "./attention";
import { DEFAULT_RULES } from "./authors";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const watch = (pr: unknown) => ({
  type: "source" as const,
  interest_id: "release",
  enabled: true,
  provider: "attention/github-pr",
  config: { pr },
});

it("names the pull request and edits whose feedback wakes agents in place", async () => {
  const user = userEvent.setup();
  const shown = presentPull(
    watch("https://github.com/block/buzz-app/pull/1578"),
    "buzz-app#1578 Release checks",
  );
  expect(shown).toMatchObject({
    type: "GitHub PR",
    icon: GitPullRequestIcon,
    target: "buzz-app#1578",
    subtitle: "Release checks",
    link: {
      href: "https://github.com/block/buzz-app/pull/1578",
      title: "Open on GitHub",
    },
  });
  const Details = shown.details as NonNullable<typeof shown.details>;
  render(<Details />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Choose who can wake agents" }),
  );
  const authors = await screen.findByRole("dialog", {
    name: "GitHub comment authors",
  });
  expect(authors).toHaveAccessibleDescription(
    "Agents watching a pull request are woken by CI, and by the comments and reviews these rules allow.",
  );
  expect(screen.getByRole("textbox", { name: /Rules/ })).toHaveValue(
    DEFAULT_RULES,
  );
});

it("leaves a watch without a pull request URL to its name", () => {
  expect(presentPull(watch(42), "Release")).toEqual({
    type: "GitHub PR",
    icon: GitPullRequestIcon,
  });
});
