import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../src/prisma/prisma.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RepositoriesService } from '../../src/repositories/repositories.service';

/**
 * #404: deleting a project must not cascade to its repositories, proven
 * against a real database rather than read off the schema.
 *
 * ## Why this cannot be a unit test
 *
 * `ProjectsService.remove()` issues one statement — `DELETE FROM projects` —
 * and everything that matters happens after it, inside Postgres, because the
 * foreign key is `ON DELETE SET NULL`. A mocked Prisma would report whatever
 * the mock was told to and would pass identically against a schema that said
 * `ON DELETE CASCADE`, which is exactly the regression this exists to catch.
 * The unit spec asserts the complementary fact — that the service does NOT
 * null `projectId` itself — so that this behaviour is the database's and can
 * be tested as the database's.
 *
 * ## Why the stakes are higher than a null column
 *
 * `WorkOrder.repository` is `onDelete: Cascade`. So a project deletion that
 * reached repositories would reach work orders, and through them runs and run
 * events — the provenance chain VISION §5 says is the product and whose holes
 * are not detectable after the fact. A work order is created here for that
 * reason: the assertion is not "a column stayed null", it is "the graph
 * survived".
 *
 * ## Why the repository rows are raw SQL
 *
 * The generated Prisma client is shared by every worktree in this checkout, so
 * a sibling branch mid-schema-change leaves `repositories` with a column this
 * branch's database does not have, and every typed `repository.*` call fails
 * on a mismatch that has nothing to do with what is being asserted. Raw SQL
 * names the columns this test actually cares about and is, in any case, the
 * honest register for a test about a referential action.
 *
 * Requires the test database from `infra/compose/test.compose.yml`
 * (`opifex_test`, host port 5433) reachable via `DATABASE_URL` / `POSTGRES_*`.
 * Skips itself, loudly, when it is not — the guard the other integration
 * specs in this directory use.
 */

function databaseReachable(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_HOST);
}

const describeIfDb = databaseReachable() ? describe : describe.skip;

if (!databaseReachable()) {
  console.warn(
    'Skipping project-delete-non-cascade.integration.spec.ts: no DATABASE_URL/POSTGRES_HOST ' +
      'in the environment. Point it at opifex_test (infra/compose/test.compose.yml) to run it.',
  );
}

interface RepositoryRow {
  id: string;
  project_id: string | null;
  observe_enabled: boolean;
  dispatch_enabled: boolean;
  mirror_labels_enabled: boolean;
}

describeIfDb(
  'Deleting a project does not delete its repositories (#404)',
  () => {
    let prisma: PrismaService;
    let projects: ProjectsService;

    /** Everything created by a test, torn down in reverse dependency order. */
    let projectIds: string[];
    let repositoryIds: string[];

    beforeAll(() => {
      prisma = new PrismaService();
      // `remove()` is the only method exercised here and it never assigns, so
      // the repositories collaborator is never called. Passing the real Prisma
      // is the part that matters.
      projects = new ProjectsService(prisma, {
        update: () => {
          throw new Error(
            'remove() must not reassign repositories; the foreign key does that',
          );
        },
      } as unknown as RepositoriesService);
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(() => {
      projectIds = [];
      repositoryIds = [];
    });

    afterEach(async () => {
      for (const id of repositoryIds) {
        await prisma.$executeRaw`DELETE FROM work_orders WHERE repository_id = ${id}::uuid`;
        await prisma.$executeRaw`DELETE FROM repositories WHERE id = ${id}::uuid`;
      }
      for (const id of projectIds) {
        await prisma.$executeRaw`DELETE FROM projects WHERE id = ${id}::uuid`;
      }
    });

    async function makeProject(label: string) {
      const project = await prisma.project.create({
        data: { slug: `${label}-${randomUUID().slice(0, 8)}`, name: label },
      });
      projectIds.push(project.id);
      return project;
    }

    async function makeRepository(projectId: string | null): Promise<string> {
      const id = randomUUID();
      const suffix = randomUUID().slice(0, 8);
      await prisma.$executeRaw`
        INSERT INTO repositories
          (id, project_id, owner, name, default_branch,
           observe_enabled, dispatch_enabled, mirror_labels_enabled,
           spec_feedback_enabled, path_constraints, created_at, updated_at)
        VALUES
          (${id}::uuid, ${projectId}::uuid, 'opifex-test', ${`non-cascade-${suffix}`}, 'main',
           true, true, true,
           false, ARRAY[]::text[], now(), now())`;
      repositoryIds.push(id);
      return id;
    }

    async function readRepository(id: string): Promise<RepositoryRow | null> {
      const rows = await prisma.$queryRaw<RepositoryRow[]>`
        SELECT id, project_id, observe_enabled, dispatch_enabled, mirror_labels_enabled
        FROM repositories WHERE id = ${id}::uuid`;
      return rows[0] ?? null;
    }

    async function makeWorkOrder(repositoryId: string): Promise<string> {
      const id = randomUUID();
      const suffix = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO work_orders
          (id, identity, repository_id, issue_number, issue_url, base_commit, attempt, branch,
           status, task_spec, acceptance_criteria, path_constraints, needs, decision_refs,
           created_at, updated_at)
        VALUES
          (${id}::uuid, ${`wo-${suffix}`}, ${repositoryId}::uuid, 1, '', ${'a'.repeat(40)}, 1,
           ${`factory/non-cascade-${suffix}`},
           'pending', 'Prove the project delete does not reach here.',
           ARRAY['It is still here afterwards.']::text[], ARRAY[]::text[], ARRAY[]::text[],
           ARRAY[]::text[], now(), now())`;
      return id;
    }

    it('leaves the repository registered and unassigned', async () => {
      const project = await makeProject('non-cascade');
      const repositoryId = await makeRepository(project.id);

      await projects.remove(project.id);

      const after = await readRepository(repositoryId);
      expect(after).not.toBeNull();
      expect(after?.project_id).toBeNull();
    });

    it('leaves the enablement ladder exactly where it was', async () => {
      // Unassigned is a state, not a demotion: a repository does not lose
      // observation or dispatch because the label around it was removed.
      const project = await makeProject('ladder-intact');
      const repositoryId = await makeRepository(project.id);

      await projects.remove(project.id);

      expect(await readRepository(repositoryId)).toMatchObject({
        observe_enabled: true,
        dispatch_enabled: true,
        mirror_labels_enabled: true,
      });
    });

    it('leaves the work orders — and so the provenance chain — untouched', async () => {
      // `WorkOrder.repository` cascades. If the project delete reached the
      // repository, this row would be gone and VISION §5's graph would have a
      // hole in it that nothing afterwards could detect.
      const project = await makeProject('provenance');
      const repositoryId = await makeRepository(project.id);
      const workOrderId = await makeWorkOrder(repositoryId);

      await projects.remove(project.id);

      const rows = await prisma.$queryRaw<Array<{ repository_id: string }>>`
        SELECT repository_id FROM work_orders WHERE id = ${workOrderId}::uuid`;
      expect(rows).toHaveLength(1);
      expect(rows[0].repository_id).toBe(repositoryId);
    });

    it('holds for a DELETE issued directly, not only for the service path', async () => {
      // The guarantee is the foreign key's. If it were application code in
      // `remove()`, a migration, a `prisma db execute`, or any future caller
      // that deletes a project another way would silently lose the rows.
      const project = await makeProject('raw-delete');
      const repositoryId = await makeRepository(project.id);

      await prisma.$executeRaw`DELETE FROM projects WHERE id = ${project.id}::uuid`;

      expect((await readRepository(repositoryId))?.project_id).toBeNull();
    });

    it('reports how many repositories it unassigned', async () => {
      const project = await makeProject('counted');
      await makeRepository(project.id);
      await makeRepository(project.id);

      const result = await projects.remove(project.id);

      expect(result.unassignedRepositories).toBe(2);
    });

    it('declares ON DELETE SET NULL on the foreign key itself', async () => {
      // The behavioural tests above would also pass if `remove()` nulled the
      // column first. This one names the mechanism, so a schema change that
      // swapped the action for CASCADE is reported as what it is rather than
      // as five confusing failures.
      const [constraint] = await prisma.$queryRaw<
        Array<{ confdeltype: string }>
        // Cast to text: `confdeltype` is a `char`, which the client refuses to
        // deserialise from a raw query.
      >`SELECT confdeltype::text AS confdeltype FROM pg_constraint WHERE conname = 'repositories_project_id_fkey'`;

      // 'n' is SET NULL. 'c' would be CASCADE, 'a' NO ACTION, 'r' RESTRICT.
      expect(constraint?.confdeltype).toBe('n');
    });

    /**
     * Controls, and the reason they are here.
     *
     * Every assertion above is of the form "the row is still there". A helper
     * that silently observed nothing — a query against the wrong table, a
     * teardown that ran early, a `readRepository` that always returned a row —
     * would satisfy all of them while proving nothing whatsoever. These two
     * run the SAME queries across the one edge in this graph that DOES
     * cascade, `work_orders.repository_id`, and demand the opposite answer. If
     * the observations were vacuous, these would pass too, and they do not.
     */
    describe('controls: the same queries across an edge that DOES cascade', () => {
      it('sees a work order disappear when its repository is deleted', async () => {
        const repositoryId = await makeRepository(null);
        const workOrderId = await makeWorkOrder(repositoryId);

        await prisma.$executeRaw`DELETE FROM repositories WHERE id = ${repositoryId}::uuid`;

        const rows = await prisma.$queryRaw<Array<{ repository_id: string }>>`
          SELECT repository_id FROM work_orders WHERE id = ${workOrderId}::uuid`;
        expect(rows).toHaveLength(0);
        expect(await readRepository(repositoryId)).toBeNull();
      });

      it('reads a DIFFERENT referential action off the catalogue', async () => {
        // The `confdeltype` assertion above would pass on a stubbed query that
        // always answered 'n'. This is the same query, one constraint over,
        // and it must answer 'c'.
        const [constraint] = await prisma.$queryRaw<
          Array<{ confdeltype: string }>
        >`SELECT confdeltype::text AS confdeltype FROM pg_constraint WHERE conname = 'work_orders_repository_id_fkey'`;

        expect(constraint?.confdeltype).toBe('c');
      });
    });

    it('keeps an unassigned repository fully usable, with no project ever created', async () => {
      // #404's other half: nothing sweeps existing repositories into a
      // "Default" project, so a repository that never had one must work
      // unchanged.
      const repositoryId = await makeRepository(null);

      const listed = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM repositories WHERE project_id IS NULL AND id = ${repositoryId}::uuid`;
      expect(listed).toHaveLength(1);

      await prisma.$executeRaw`
        UPDATE repositories SET dispatch_enabled = true WHERE id = ${repositoryId}::uuid`;

      expect(await readRepository(repositoryId)).toMatchObject({
        project_id: null,
        dispatch_enabled: true,
      });
    });
  },
);
