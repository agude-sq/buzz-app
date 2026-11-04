// How a pull request watch looks in Agent Attention.
import { GitPullRequestIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import type {
  AttentionDialog,
  AttentionSource,
} from "../../features/agents/attention-sources";
import { AuthorSettings } from "./AuthorSettings";
import { pullOf } from "./watch";

/** Whose feedback wakes agents: one device-wide editor, whichever watch
 * opened it. */
export const authorDialog: AttentionDialog = {
  id: "authors",
  title: "GitHub comment authors",
  description:
    "Agents watching a pull request are woken by CI, and by the comments and reviews these rules allow.",
  component: AuthorSettings,
};

/** Opens the rules for whose feedback wakes agents. */
function Authors({ openDialog }: { openDialog(id: string): void }) {
  return (
    <Button
      variant="link"
      size="inline"
      type="button"
      onClick={() => openDialog(authorDialog.id)}
    >
      Choose who can wake agents
    </Button>
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
