/**
 * Standing a repository down — and the narrow case where removing it outright
 * is honest (#405, epic #403).
 *
 * ## Two different acts, rendered as two different things
 *
 * **Retire** stands the whole ladder down in one act and keeps everything
 * else: the work orders, the runs, the events, the provenance graph VISION §5
 * calls the product. It is the right answer for anything that has ever run,
 * and it is reversible.
 *
 * **De-register** removes the row. `DELETE /api/repositories/:id` is refused
 * with a 400 while any work order exists, precisely because it would cascade
 * that history away. So it is only ever an option for a repository nothing has
 * happened in.
 *
 * ## Which one is offered is a question this dialog ASKS
 *
 * Nothing on the repository says how many work orders it has, and guessing
 * from `lastObservedAt` would be an inference. So the dialog asks
 * `GET /api/work-orders?repository=…` when it opens and offers de-registering
 * only on a confirmed zero. Three answers, three renderings:
 *
 *  - **counted, zero** — de-register is offered beside retire, with what each
 *    one does said in one line.
 *  - **counted, more than zero** — it is not offered, and the count is the
 *    reason given. The operator is told the number rather than being walked
 *    into the API's refusal.
 *  - **unknown** — the count could not be read (this account may not hold
 *    `workorders:read`, which is a different permission from the one that
 *    opened this screen). De-registering is NOT offered, and the dialog says
 *    it is withholding the option because it could not check — never that
 *    there is nothing there.
 *
 * That last case is the one worth having. An account can manage repositories
 * and not read work orders, and answering "no history" to somebody who simply
 * may not ask would be the inference this epic keeps naming.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import {
  countRepositoryWorkOrders,
  type RepositoryWorkOrderCount,
} from '../../services/api';
import type { RepositorySummary } from '../../types/cockpit';
import { useIsMounted } from '../../hooks/useIsMounted';

export interface RetireRepositoryDialogProps {
  repository: RepositorySummary;
  /** `projects:write`. Without it both actions are refused API-side anyway. */
  canWrite: boolean;
  onClose: () => void;
  /** Rejects with the API's own refusal, which this dialog renders. */
  onRetire: (reason?: string) => Promise<void>;
  /** Rejects with the API's own refusal — including the 400 it documents. */
  onDeregister: () => Promise<void>;
}

/**
 * Mounted only while open, so the work-order count is asked once per opening
 * rather than once per card on every render of the panel.
 */
export function RetireRepositoryDialog({
  repository,
  canWrite,
  onClose,
  onRetire,
  onDeregister,
}: RetireRepositoryDialogProps) {
  const [reason, setReason] = useState('');
  const [count, setCount] = useState<RepositoryWorkOrderCount | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const load = useCallback(async () => {
    // Resolves for every outcome — see `countRepositoryWorkOrders`. There is
    // no rejection to catch here, only an answer that may be `unknown`.
    const answer = await countRepositoryWorkOrders(repository.fullName);
    if (isMounted()) setCount(answer);
  }, [isMounted, repository.fullName]);

  // Asked once, when the dialog opens. Nothing is set before the first
  // `await` — `count` starts null and stays null until the answer lands — so
  // there is no cascading render to remove; the rule cannot see past the
  // async call. The same reasoning `useAvailableRepositories` records.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount, see above
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    setIsWorking(true);
    try {
      await action();
      // Closed by the caller on success only. A dialog that closed on a
      // rejection would take the API's reason with it.
      onClose();
    } catch (err) {
      if (isMounted()) {
        setError(
          err instanceof Error ? err.message : 'The API refused the request.',
        );
      }
    } finally {
      if (isMounted()) setIsWorking(false);
    }
  };

  const trimmedReason = reason.trim();

  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="retire-repository-title"
    >
      <DialogTitle id="retire-repository-title">
        Retire {repository.fullName}?
      </DialogTitle>

      <DialogContent dividers>
        <DialogContentText>
          Retiring turns every rung off — observe, mirror labels, spec feedback
          and dispatch — and records that it was a decision rather than a lapse.
          The work orders, runs and events stay exactly where they are. It can
          be un-retired at any time, which returns it to the bottom of the
          ladder.
        </DialogContentText>

        <TextField
          label="Why (optional)"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          fullWidth
          multiline
          minRows={2}
          disabled={!canWrite || isWorking}
          sx={{ mt: 2 }}
          helperText={
            'Recorded on the audit row. Optional, because a required ' +
            'justification produces the string “asdf”.'
          }
          slotProps={{ htmlInput: { maxLength: 500 } }}
        />

        <Deregistration count={count} />

        {error !== null && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>

      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onClose} disabled={isWorking}>
          Cancel
        </Button>
        {count?.state === 'counted' && count.total === 0 && (
          <Button
            color="error"
            disabled={!canWrite || isWorking}
            onClick={() => void run(onDeregister)}
          >
            De-register instead
          </Button>
        )}
        <Button
          variant="contained"
          color="warning"
          disabled={!canWrite || isWorking}
          startIcon={isWorking ? <CircularProgress size={14} /> : undefined}
          onClick={() =>
            void run(() =>
              onRetire(trimmedReason === '' ? undefined : trimmedReason),
            )
          }
        >
          Retire
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Whether removing the row outright is even on the table, and why.
 *
 * Never silent. Each of the three answers says something different, and the
 * one that says nothing — a missing paragraph — would leave an operator
 * wondering where the Remove button went.
 */
function Deregistration({ count }: { count: RepositoryWorkOrderCount | null }) {
  if (count === null) {
    return (
      <Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: 'center' }}>
        <CircularProgress size={14} />
        <Typography variant="body2" color="text.secondary">
          Checking whether anything has run here…
        </Typography>
      </Stack>
    );
  }

  if (count.state === 'unknown') {
    return (
      <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
        <AlertTitle>De-registering is not offered here</AlertTitle>
        This build could not read how many work orders this repository has, so
        it will not offer an action that removes them. {count.detail}
      </Alert>
    );
  }

  if (count.total > 0) {
    return (
      <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
        <AlertTitle>
          {count.total} work {count.total === 1 ? 'order' : 'orders'} — retire
          is the only removal
        </AlertTitle>
        De-registering is refused while any work order exists, because it would
        cascade away those runs and their provenance. Retiring is the operation
        that stands the repository down and leaves that history in place.
      </Alert>
    );
  }

  return (
    <Alert severity="warning" variant="outlined" sx={{ mt: 2 }}>
      <AlertTitle>Nothing has run here</AlertTitle>
      No work order references this repository, so de-registering it removes the
      row and loses nothing. That is permanent and there is no un-retire for it
      — retiring is still the reversible choice.
    </Alert>
  );
}

export default RetireRepositoryDialog;
