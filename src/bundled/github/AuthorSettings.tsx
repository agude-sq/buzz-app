import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { loadPolicy, open, parse, savePolicy, type Rule } from "./authors";

type Draft = { text: string; fallback: Rule["effect"]; checked: boolean };
/** The unsaved rules of the latest visit, kept while Back hides its dialog so
 * Forward restores them; opening the editor again starts from what is saved. */
let held: { visit: string; draft: Draft } | undefined;

/** Whose pull request comments and reviews wake agents watching it. `visit`
 * names the dialog's presentation, whose unsaved edits outlast it. */
export function AuthorSettings({ visit }: { visit?: string }) {
  const [saved, setSaved] = useState(loadPolicy);
  const [kept] = useState(() =>
    visit && held?.visit === visit ? held.draft : undefined,
  );
  const [draft, setDraftText] = useState(kept?.text ?? saved.text);
  const [fallback, setFallbackEffect] = useState(
    kept?.fallback ?? saved.fallback,
  );
  /** Why the rules could not be saved, apart from why they are not rules. */
  const [error, setError] = useState("");
  // After a Save, each edit checks the rules again.
  const [checked, setCheckedState] = useState(
    kept?.checked ?? saved.error !== undefined,
  );
  const hold = (next: Partial<Draft>) => {
    if (visit)
      held = {
        visit,
        draft: { text: draft, fallback, checked, ...next },
      };
  };
  const setDraft = (text: string) => {
    setDraftText(text);
    hold({ text });
  };
  const setFallback = (effect: Rule["effect"]) => {
    setFallbackEffect(effect);
    hold({ fallback: effect });
  };
  const setChecked = (value: boolean) => {
    setCheckedState(value);
    hold({ checked: value });
  };
  const parsed = parse(draft);
  const dirty =
    typeof parsed === "string" ||
    parsed.text !== saved.text ||
    fallback !== saved.fallback;
  return (
    <form
      aria-label="GitHub comment author rules"
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty) return;
        setChecked(true);
        if (typeof parsed === "string") return;
        try {
          const policy = savePolicy(draft, fallback);
          setSaved(policy);
          setDraftText(policy.text);
          setCheckedState(false);
          setError("");
          if (held?.visit === visit) held = undefined;
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }}
    >
      <SettingsGroup layout="form">
        {saved.error !== undefined && (
          <p role="status" className="m-0 text-body-sm text-subtle">
            Your saved rules no longer parse, so no comment or review wakes your
            agents until you fix them.
          </p>
        )}
        {open(saved) && (
          <p role="status" className="m-0 text-body-sm text-subtle">
            Comments from anyone no rule denies can wake your agents. To limit
            them, allow only org:name or author:login, and don’t wake them when
            no rule matches.
          </p>
        )}
        <Field
          label="Rules"
          error={checked && typeof parsed === "string" ? parsed : undefined}
          description="One per line: allow or deny, then any of author:login, author:/pattern/, org:organization, body:/pattern/ and prefix:text, which runs to the end of the line. Patterns are JavaScript regular expressions without backreferences, lookaround or escapes JavaScript reads as plain letters, such as \q. body: sees a comment's first 1,000 characters, the most a wake quotes. A bare allow or deny matches everyone. author:@me is your GitHub account, a bot's login ends in [bot], and logins match case aside. The first rule that matches decides. Membership your GitHub account cannot see, or of a misspelled organization, counts as none."
        >
          <Textarea
            rows={6}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </Field>
        <Field label="When no rule matches" nativeLabel={false}>
          <RadioGroup<Rule["effect"]>
            aria-label="When no rule matches"
            value={fallback}
            onValueChange={setFallback}
          >
            <Radio value="allow" label="Wake the agent" />
            <Radio value="deny" label="Don’t wake it" />
          </RadioGroup>
        </Field>
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button type="submit" variant="primary" disabled={!dirty}>
            Save
          </Button>
        </div>
      </SettingsGroup>
    </form>
  );
}
