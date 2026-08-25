import { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Container,
  Divider,
  Link,
  List,
  ListItem,
  ListItemText,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';

import { COCKPIT_POLL_INTERVAL_MS } from '../config/cockpitApi';
import { usePolledResource } from '../hooks/usePolledResource';
import { getWorkOrder } from '../services/api';
import { formatCost } from '../components/runs/runColumns';
import {
  branchUrl,
  executionRecordUrl,
  identityMatchesDocument,
} from '../components/runs/workOrderRecords';
import { formatRelativeTime } from '../utils/time';
import type { WorkOrderDetail } from '../types/cockpit';

const MONO = { fontFamily: 'monospace' } as const;

/**
 * `/work-orders/:idOrIdentity` — the order, its records, and every attempt (#84).
 *
 * ## Both records, findable
 *
 * VISION §4 records a work order twice — a fenced JSON comment on the issue and
 * the first commit on its branch — and #63 says why: keeping both is what makes
 * *"the agent did something I did not ask for"* a checkable claim rather than an
 * argument. This page links to both so the check does not mean opening two
 * GitHub tabs and diffing by eye.
 *
 * ## All attempts together
 *
 * Attempts per work order is success metric 4 (VISION §10), and #84 puts it
 * plainly: *"seeing three attempts on one order is how a too-large work order
 * announces itself."* So they are listed together with their outcomes rather
 * than scattered across the runs screen.
 *
 * ## The order is rendered, never dumped
 *
 * #84's first acceptance criterion is that it read as prose, not as a JSON
 * blob. Task spec and acceptance criteria are the fields a human checks the
 * agent's work against, so they lead; the ceilings and constraints follow as
 * facts.
 */
export default function WorkOrderDetailPage() {
  const { idOrIdentity = '' } = useParams<{ idOrIdentity: string }>();

  const fetcher = useCallback(
    (signal: AbortSignal) => getWorkOrder(idOrIdentity, signal),
    [idOrIdentity],
  );
  const { data, error } = usePolledResource<WorkOrderDetail>({
    fetcher,
    fetcherKey: [idOrIdentity],
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: Boolean(idOrIdentity),
  });

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 2 }}>
        {error && !data && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {!data && !error && <Skeleton height={160} />}
        {data && <WorkOrderBody detail={data} />}
      </Box>
    </Container>
  );
}

function WorkOrderBody({ detail }: { detail: WorkOrderDetail }) {
  const { document } = detail;
  const consistency = identityMatchesDocument(document);

  return (
    <>
      <Typography variant="h4" component="h1" gutterBottom>
        Work order
      </Typography>

      <IdentityLine identity={document.identity} />

      {/* The one comparison this screen can make without a network call. See
          workOrderRecords.ts on why the full record diff is not here. */}
      {!consistency.agrees && (
        <Alert severity="warning" sx={{ my: 2 }}>
          The identity and the document disagree: {consistency.reason}
        </Alert>
      )}

      <Stack direction="row" spacing={2} sx={{ my: 2, flexWrap: 'wrap' }}>
        <Chip label={detail.status} size="small" />
        <Chip
          label={`attempt ${document.attempt}`}
          size="small"
          variant="outlined"
        />
        {detail.holdReason && (
          <Chip label={detail.holdReason} size="small" color="warning" />
        )}
      </Stack>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Task
          </Typography>
          <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', mb: 2 }}>
            {document.taskSpec}
          </Typography>

          <Typography variant="subtitle2" gutterBottom>
            Acceptance criteria
          </Typography>
          <List dense>
            {document.acceptanceCriteria.map((criterion, index) => (
              <ListItem key={index} sx={{ py: 0 }}>
                <ListItemText primary={criterion} />
              </ListItem>
            ))}
          </List>

          <Divider sx={{ my: 2 }} />

          <Stack direction="row" spacing={4} sx={{ flexWrap: 'wrap' }}>
            <Fact
              label="Budget ceiling"
              value={formatCost(document.budgetCeilingUsd)}
            />
            <Fact
              label="Wall-clock timeout"
              value={
                document.wallClockTimeoutMinutes === null
                  ? '—'
                  : `${document.wallClockTimeoutMinutes} min`
              }
            />
            <Fact label="Base commit" value={document.baseCommit.slice(0, 7)} />
            <Fact
              label="Needs"
              value={
                document.needs.length ? document.needs.join(', ') : 'any runner'
              }
            />
          </Stack>

          {document.pathConstraints.length > 0 && (
            <>
              <Typography variant="subtitle2" sx={{ mt: 2 }}>
                Path constraints
              </Typography>
              <Typography variant="body2" sx={MONO}>
                {document.pathConstraints.join(', ')}
              </Typography>
            </>
          )}
        </CardContent>
      </Card>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            The two records
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            VISION §4 records a work order twice — a comment on the issue
            proving what was approved, and the branch&apos;s first commit
            proving what the runner was given. Both carry the same bytes by
            construction: one serialization feeds both writes.
          </Typography>

          <Stack direction="row" spacing={3} sx={{ flexWrap: 'wrap' }}>
            {detail.authorizationCommentUrl ? (
              <Link
                href={detail.authorizationCommentUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Authorization record
              </Link>
            ) : (
              <Typography variant="body2" color="text.disabled">
                Authorization record — not posted yet
              </Typography>
            )}
            <Link
              href={executionRecordUrl(document)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Execution record
            </Link>
            <Link
              href={branchUrl(document)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Branch
            </Link>
            <Link
              href={document.issue.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Issue #{document.issue.number}
            </Link>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Attempts
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Attempts per work order is success metric 4. Three attempts on one
            order is how a too-large work order announces itself.
          </Typography>

          {detail.runs.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No attempts yet.
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Status</TableCell>
                  <TableCell>Runner</TableCell>
                  <TableCell>Started</TableCell>
                  <TableCell align="right">Cost</TableCell>
                  <TableCell align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {detail.runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>{run.status}</TableCell>
                    <TableCell>{run.runner}</TableCell>
                    <TableCell>
                      {formatRelativeTime(run.startedAt) ?? '—'}
                    </TableCell>
                    <TableCell align="right">
                      {formatCost(run.costUsd)}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        component={RouterLink}
                        to={`/runs/${run.id}`}
                      >
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/**
 * The identity, copyable.
 *
 * #84 asks for this specifically: it is the key an operator uses to correlate
 * across GitHub, logs and telemetry, and retyping a 40-character string by hand
 * is where transcription errors come from.
 */
function IdentityLine({ identity }: { identity: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <Typography variant="body1" sx={MONO}>
        {identity}
      </Typography>
      <Button
        size="small"
        onClick={() => {
          void navigator.clipboard?.writeText(identity).then(
            () => setCopied(true),
            // A clipboard the browser refuses is not an error worth an alert;
            // the identity is on screen and selectable either way.
            () => setCopied(false),
          );
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </Stack>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography>
    </Box>
  );
}
