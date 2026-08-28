/**
 * Where an instruction is typed (#426).
 *
 * The examples are beside the box rather than in an error afterwards: the
 * deterministic parser handles instructions naming explicit issue numbers with
 * no model at all, and a deployment with no chat model configured — which is
 * every deployment today, since the model path is refused for want of a spend
 * ceiling — can steer perfectly well by typing one. Telling an operator that
 * only after their sentence has come back as `needs-interpretation` is telling
 * them too late.
 */

import { useState } from 'react';
import { Box, Button, Stack, TextField, Typography } from '@mui/material';

import {
  INSTRUCTION_EXAMPLES,
  INSTRUCTION_MAX_LENGTH,
} from '../../config/steeringChat';

export function InstructionComposer({
  disabled,
  onPropose,
}: {
  disabled: boolean;
  /** Proposes. It never applies — there is no path from this box to a write. */
  onPropose: (instruction: string, repository?: string) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [repository, setRepository] = useState('');

  const trimmed = instruction.trim();
  const tooLong = trimmed.length > INSTRUCTION_MAX_LENGTH;
  const canSend = trimmed.length > 0 && !tooLong && !disabled;

  function send() {
    if (!canSend) return;
    onPropose(trimmed, repository.trim() || undefined);
    setInstruction('');
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

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          sx={{ alignItems: { sm: 'center' } }}
        >
          <TextField
            label="Repository (optional)"
            placeholder="owner/name"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            size="small"
            sx={{ flexGrow: 1 }}
            slotProps={{
              htmlInput: { 'aria-label': 'Repository for bare issue numbers' },
            }}
            helperText="Which repository a bare #12 means. Needed when more than one is registered."
          />
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
