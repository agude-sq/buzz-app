import type { MouseEvent } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ArrowClockwiseIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons/index";
import styles from "./Messages.module.css";

const failure = "Couldn't load image";

/** A failed image's status and Retry over its preview. The space it covers
    chooses the layout, so message tiles and the viewer share it. */
export function ImageLoadError({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry(): void;
}) {
  const retry = (event: MouseEvent<HTMLButtonElement>) => {
    // Retry never also activates an opener around the image.
    event.stopPropagation();
    onRetry();
  };
  return (
    <span className={`${styles.imageLoadError} dark`} data-color-mode="dark">
      <span className={styles.imageLoadErrorContent}>
        <WarningCircleIcon
          size={20}
          aria-hidden="true"
          style={{ visibility: retrying ? "hidden" : undefined }}
        />
        <span role="status">{retrying ? "Loading image…" : failure}</span>
        <Button
          size="sm"
          loading={retrying}
          aria-label="Retry image"
          data-image-retry="label"
          onClick={retry}
        >
          Retry
        </Button>
        <IconButton
          size="sm"
          shape="round"
          variant="subtle"
          loading={retrying}
          aria-label={`${failure}. Retry`}
          title={`${failure}. Retry`}
          data-image-retry="icon"
          onClick={retry}
          icon={<ArrowClockwiseIcon size={16} aria-hidden="true" />}
        />
      </span>
    </span>
  );
}
