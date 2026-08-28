/**
 * The proposed diff, and the confirmation over it (#426).
 *
 * ## What this screen is for
 *
 * Not "here is what I did" — *here is what I am about to do*. Nothing in this
 * component writes, and the only way anything is written is the button at the
 * bottom, pressed by a person, after the list above it exists on screen.
 *
 * ## The order is the argument
 *
 * 1. **The blast radius**, from the API's own counts, stating additions and
 *    removals together. It is rendered before any operation, because a list is
 *    something to check a claim against and the claim has to come first.
 * 2. **How the instruction was read**, when it could not be read
 *    deterministically — as information, since that is the ordinary answer for
 *    prose today.
 * 3. **The issues the operator NAMED**, then **the collateral**, in separate
 *    sections with their own headings and counts. An "only" clause takes
 *    `factory:ready` off issues nobody typed, and a flat list would bury those
 *    among the ones that were asked for.
 * 4. **What was already true**, listed and not counted.
 * 5. **The confirmation**, restating the removals one last time.
 *
 * ## Narrowing
 *
 * Each changing operation carries a checkbox, and only ticked operations are
 * sent. Un-ticking is how an operator says "not that one" without retyping the
 * instruction, and it is the reason the blast radius above is read from
 * `blastRadius` rather than recomputed from the ticks: the headline states
 * what the INSTRUCTION means, and would otherwise shrink as the selection
 * narrowed until an operator who un-ticked everything read "nothing will
 * change" over a proposal that removes seventeen labels.
 */

import { useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';

import { RELEASE_CAVEATS } from '../../config/queueSteering';
import {
  blastRadiusHeadline,
  expiryNotice,
  interpretationNotice,
  isChanging,
  partitionOperations,
  resolutionFailures,
} from '../../config/steeringChat';
import type { SteeringOperation, SteeringProposal } from '../../types/steering';
import { LabelDiff } from './LabelDiff';

export function ProposalReview({
  proposal,
  interactive,
  isApplying,
  onApply,
  onDiscard,
  now = new Date(),
}: {
  proposal: SteeringProposal;
  /** False for a proposal that has been applied, discarded or superseded. */
  interactive: boolean;
  isApplying: boolean;
  onApply: (operations: SteeringOperation[]) => void;
  onDiscard: () => void;
  /** Injected so the expiry sentence is testable without faking a clock. */
  now?: Date;
}) {
  const { named, collateral, unchanged } = partitionOperations(
    proposal.operations,
  );
  const changing = proposal.operations.filter(isChanging);

  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const selected = changing.filter((operation) => !excluded.has(operation.ref));

  function toggle(ref: string) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  }

  const headline = blastRadiusHeadline(proposal);
  const interpretation = interpretationNotice(proposal);
  const failures = resolutionFailures(proposal);
  const expiry = expiryNotice(proposal.expiresAt, now);

  const selectedAdds = selected.reduce((n, o) => n + o.add.length, 0);
  const selectedRemovals = selected.reduce((n, o) => n + o.remove.length, 0);

  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid="proposal-review">
      <Typography variant="overline" color="text.secondary">
        Proposed — nothing has been written
      </Typography>

      <Alert severity={headline.severity} sx={{ mt: 1 }}>
        <AlertTitle>{headline.title}</AlertTitle>
        {headline.body.map((line) => (
          <Typography key={line} variant="body2" sx={{ mb: 0.5 }}>
            {line}
          </Typography>
        ))}
      </Alert>

      {interpretation !== null && (
        <Alert severity={interpretation.severity} sx={{ mt: 1.5 }}>
          <AlertTitle>{interpretation.title}</AlertTitle>
          {interpretation.body.map((line) => (
            <Typography key={line} variant="body2" sx={{ mb: 0.5 }}>
              {line}
            </Typography>
          ))}
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {interpretation.remedy}
          </Typography>
        </Alert>
      )}

      {failures.length > 0 && (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          <AlertTitle>
            {failures.length === 1
              ? 'One reference produced no operation'
              : `${failures.length} references produced no operation`}
          </AlertTitle>
          <Stack spacing={0.5}>
            {failures.map((failure) => (
              <Box key={`${failure.reference}-${failure.reason}`}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {failure.reference} — {failure.reason}
                </Typography>
                <Typography variant="body2">{failure.detail}</Typography>
              </Box>
            ))}
          </Stack>
        </Alert>
      )}

      <OperationSection
        title={`Issues you named (${named.length})`}
        caption="The issues the instruction referred to directly."
        operations={named}
        interactive={interactive}
        excluded={excluded}
        onToggle={toggle}
      />

      <OperationSection
        title={`Collateral — not named by your instruction (${collateral.length})`}
        caption={
          'These change because the instruction was exclusive. Nobody typed ' +
          'them, and un-readying one discards intent somebody set deliberately.'
        }
        operations={collateral}
        interactive={interactive}
        excluded={excluded}
        onToggle={toggle}
      />

      <OperationSection
        title={`Already in the state asked for (${unchanged.length})`}
        caption="Listed so a named issue is never silently absent. Nothing would be written for these, and they are not in the counts above."
        operations={unchanged}
        interactive={false}
        excluded={excluded}
        onToggle={toggle}
      />

      {proposal.blastRadius.readied > 0 && (
        <Stack spacing={0.5} sx={{ mt: 2 }}>
          {RELEASE_CAVEATS.map((caveat) => (
            <Typography key={caveat} variant="caption" color="text.secondary">
              {caveat}
            </Typography>
          ))}
        </Stack>
      )}

      <Divider sx={{ my: 2 }} />

      <Typography
        variant="body2"
        color={expiry.urgent ? 'warning.main' : 'text.secondary'}
        sx={{ mb: 1 }}
      >
        {expiry.text}
      </Typography>

      {interactive && (
        <>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {selected.length === 0
              ? 'Nothing is selected, so there is nothing to apply. Tick the issues to include.'
              : `Applying ${selected.length} of ${changing.length} operations: ${selectedAdds} labels added, ${selectedRemovals} removed.`}
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button
              variant="contained"
              color={proposal.blastRadius.destructive ? 'warning' : 'primary'}
              disabled={selected.length === 0 || isApplying || expiry.expired}
              onClick={() => onApply(selected)}
              aria-label="Apply the selected label changes"
            >
              {isApplying ? 'Applying…' : `Apply ${selected.length} operations`}
            </Button>
            <Button
              variant="outlined"
              disabled={isApplying}
              onClick={onDiscard}
              aria-label="Discard this proposal without writing anything"
            >
              Discard
            </Button>
          </Stack>
        </>
      )}
    </Paper>
  );
}

function OperationSection({
  title,
  caption,
  operations,
  interactive,
  excluded,
  onToggle,
}: {
  title: string;
  caption: string;
  operations: readonly SteeringOperation[];
  interactive: boolean;
  excluded: ReadonlySet<string>;
  onToggle: (ref: string) => void;
}) {
  if (operations.length === 0) return null;

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2">{title}</Typography>
      <Typography variant="caption" color="text.secondary">
        {caption}
      </Typography>
      <Stack spacing={1} sx={{ mt: 1 }}>
        {operations.map((operation) => (
          <Stack
            key={operation.ref}
            direction="row"
            spacing={1}
            sx={{ alignItems: 'flex-start' }}
          >
            {interactive && (
              <Checkbox
                size="small"
                checked={!excluded.has(operation.ref)}
                onChange={() => onToggle(operation.ref)}
                slotProps={{
                  input: { 'aria-label': `Include ${operation.ref}` },
                }}
                sx={{ mt: 0.25 }}
              />
            )}
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {operation.ref}
                {operation.title ? ` — ${operation.title}` : ''}
              </Typography>
              <LabelDiff add={operation.add} remove={operation.remove} />
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block' }}
              >
                {operation.reason}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block' }}
              >
                Labels observed now:{' '}
                {operation.observedInputLabels.length > 0
                  ? operation.observedInputLabels.join(', ')
                  : 'none'}
              </Typography>
            </Box>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}
