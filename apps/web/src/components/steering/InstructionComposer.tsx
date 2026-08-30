/**
 * Where an instruction is typed (#426), and where it applies (#460).
 *
 * The examples are beside the box rather than in an error afterwards: the
 * deterministic parser handles instructions naming explicit issue numbers with
 * no model at all, and a deployment with no chat model configured — which is
 * every deployment today, since the model path is refused for want of a spend
 * ceiling — can steer perfectly well by typing one. Telling an operator that
 * only after their sentence has come back as `needs-interpretation` is telling
 * them too late.
 *
 * ## The scope comes first, and stays visible
 *
 * `Repository (optional)` used to be a free-text box UNDER the instruction. It
 * is now a `ScopePicker` above it, chosen from projects, repositories and the
 * unassigned bucket the API actually served, and its consequence is restated
 * as a chip beside Propose. Both moves answer the same complaint: where an
 * instruction lands was the one thing on this form that could be wrong without
 * looking wrong, and it was the thing an operator had to scroll back to in
 * order to check.
 *
 * ## What an unset scope now means, said before the round trip
 *
 * Since ADR-0020 an exclusive `ready` instruction — "only work on #1 and #2",
 * whose second half is "hold everything else" — with no scope over more than
 * one registered repository is answered `ambiguous-scope` and sweeps nothing,
 * where it used to sweep every observed repository silently. The composer says
 * so under the box while the instruction is being written, because the API's
 * answer arrives after the operator has already pressed Propose, and a refusal
 * they could have avoided reads as the tool being difficult.
 */

import { useMemo, useState } from 'react';
import { Box, Button, Chip, Stack, TextField, Typography } from '@mui/material';

import {
  INSTRUCTION_EXAMPLES,
  INSTRUCTION_MAX_LENGTH,
} from '../../config/steeringChat';
import {
  UNSCOPED_ID,
  findScope,
  unscopedIsUnambiguous,
} from '../../config/steeringScope';
import { useSteeringScopes } from '../../hooks/useSteeringScopes';
import type { SteeringScopeRequest } from '../../types/steering';
import { ScopePicker } from './ScopePicker';

export function InstructionComposer({
  disabled,
  onPropose,
}: {
  disabled: boolean;
  /**
   * Proposes. It never applies — there is no path from this box to a write.
   *
   * The scope is one member of an exclusive union, so what reaches
   * `POST /steering/proposals` carries at most one of `repository`, `project`
   * and `allRepositories` by construction rather than by a check.
   */
  onPropose: (instruction: string, scope: SteeringScopeRequest) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [scopeId, setScopeId] = useState<string>(UNSCOPED_ID);
  const { catalogue, isLoading, error, truncated } = useSteeringScopes();

  // The chosen option, re-derived from the catalogue rather than stored: a
  // list that reloads must not leave a selection pointing at an option that no
  // longer exists, and `findScope` falls back to unscoped rather than to a
  // stale repository nobody can see in the control any more.
  const selected = useMemo(
    () => findScope(catalogue.options, scopeId),
    [catalogue.options, scopeId],
  );

  const trimmed = instruction.trim();
  const tooLong = trimmed.length > INSTRUCTION_MAX_LENGTH;
  const canSend = trimmed.length > 0 && !tooLong && !disabled;

  // The refusal an unset scope earns, said before it is earned. Not a block:
  // a non-exclusive instruction naming `owner/name#12` is perfectly valid with
  // no scope at all, and this form cannot tell which kind is being typed
  // without re-implementing the API's parser.
  const unscopedWarning =
    selected.kind === 'unscoped' &&
    !isLoading &&
    error === null &&
    catalogue.registered > 0 &&
    !unscopedIsUnambiguous(catalogue);

  function send() {
    if (!canSend) return;
    onPropose(trimmed, selected.request);
    setInstruction('');
    // The scope is NOT reset. An operator steering a project types several
    // instructions at it, and clearing the scope between them would make the
    // wide, unscoped state the one you arrive at by doing nothing.
  }

  return (
    <Box
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      sx={{ mt: 2 }}
    >
      <Stack spacing={1.5}>
        <ScopePicker
          catalogue={catalogue}
          isLoading={isLoading}
          error={error}
          truncated={truncated}
          selected={selected}
          disabled={disabled}
          onSelect={setScopeId}
        />

        <TextField
          label="What should the factory work on?"
          placeholder={INSTRUCTION_EXAMPLES[0]}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          multiline
          minRows={2}
          fullWidth
          error={tooLong}
          helperText={
            tooLong
              ? `An instruction is at most ${INSTRUCTION_MAX_LENGTH} characters; this one is ${trimmed.length}.`
              : 'Nothing is written when you send this. You will see the label changes first and confirm them separately.'
          }
          slotProps={{ htmlInput: { 'aria-label': 'Steering instruction' } }}
        />

        {unscopedWarning && (
          <Typography variant="caption" color="warning.main" component="p">
            No scope is chosen, so a bare #12 has {catalogue.registered}{' '}
            repositories it could mean, and an instruction that holds everything
            else is refused rather than swept across all of them. Choose a scope
            above, or write each issue out as owner/name#12.
          </Typography>
        )}

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          sx={{ alignItems: { sm: 'center' } }}
        >
          {/* The scope, restated where the action is. `catalogue.options` is
              empty on a one-repository deployment, and so is this: there the
              scope is a fact stated once above, not a choice to re-check. */}
          {catalogue.options.length > 0 && (
            <Chip
              size="small"
              variant="outlined"
              color={
                selected.kind === 'all-repositories' ? 'warning' : 'default'
              }
              label={`Applies to: ${selected.label}`}
            />
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Button
            type="submit"
            variant="contained"
            disabled={!canSend}
            aria-label="Propose a label diff for this instruction"
          >
            Propose
          </Button>
        </Stack>

        <Box>
          <Typography variant="caption" color="text.secondary">
            Instructions naming issue numbers are parsed in code and need no
            chat model:
          </Typography>
          <Stack component="ul" sx={{ m: 0, pl: 3 }} spacing={0}>
            {INSTRUCTION_EXAMPLES.map((example) => (
              <Typography
                key={example}
                component="li"
                variant="caption"
                color="text.secondary"
              >
                {example}
              </Typography>
            ))}
          </Stack>
        </Box>
      </Stack>
    </Box>
  );
}
