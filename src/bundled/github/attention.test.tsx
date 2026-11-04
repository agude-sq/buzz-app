// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { GitPullRequestIcon } from "../../shared/design-system/icons";
import { authorDialog, presentPull } from "./attention";
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

it("names the pull request and opens whose feedback wakes agents as a dialog", async () => {
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
  const openDialog = vi.fn();
  render(<Details openDialog={openDialog} />);
  await user.click(
    screen.getByRole("button", { name: "Choose who can wake agents" }),
  );
  expect(openDialog).toHaveBeenCalledWith(authorDialog.id);
  // The editor is the source's dialog, not part of the watch's details.
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  cleanup();
  const Editor = authorDialog.component;
  render(<Editor visit="first" />);
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
