// How a pull request watch looks in Agent Attention.
import { useState } from "react";
import { GitPullRequestIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import type { AttentionSource } from "../../features/agents/attention-sources";
import { AuthorSettings } from "./AuthorSettings";
import { pullOf } from "./watch";

/** Opens the rules for whose feedback wakes agents. */
function Authors() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="link"
        size="inline"
        type="button"
        onClick={() => setOpen(true)}
      >
        Choose who can wake agents
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        headerGap="compact"
        title="GitHub comment authors"
        description="Agents watching a pull request are woken by CI, and by the comments and reviews these rules allow."
      >
        <AuthorSettings />
      </Dialog>
    </>
  );
}

/** Names the pull request a watch follows, with whose feedback wakes agents
 * in its details. */
export const presentPull: NonNullable<AttentionSource["present"]> = (
  watch,
  title,
) => {
  const pull =
    typeof watch.config.pr === "string" ? pullOf(watch.config.pr) : undefined;
  if (!pull) return { type: "GitHub PR", icon: GitPullRequestIcon };
  return {
    type: "GitHub PR",
    icon: GitPullRequestIcon,
    target: `${pull.name}#${pull.number}`,
    subtitle: title.replace(/^(?:PR\s+\d+:?\s*|[^ ]*#\d+\s*)/i, ""),
    link: { href: pull.url, title: "Open on GitHub" },
    details: Authors,
  };
};
