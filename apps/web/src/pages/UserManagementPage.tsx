import { useState } from 'react';
import { Container, Typography, Box, Tabs, Tab, Paper } from '@mui/material';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../hooks/usePermissions';
import { RequirePermission } from '../components/common/RequirePermission';
import { UserList } from '../components/admin/UserList';
import { AllowlistTable } from '../components/admin/AllowlistTable';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel({ children, value, index }: TabPanelProps) {
  return (
    <div role="tabpanel" hidden={value !== index}>
      {value === index && <Box sx={{ py: 3 }}>{children}</Box>}
    </div>
  );
}

export default function UserManagementPage() {
  const { hasPermission } = usePermissions();
  const [tabIndex, setTabIndex] = useState(0);

  // Check permission - require users:read to access
  if (!hasPermission('users:read')) {
    return <Navigate to="/" replace />;
  }

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          User Management
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Manage users and email allowlist
        </Typography>

        <Paper sx={{ mt: 2 }}>
          <Tabs
            value={tabIndex}
            onChange={(_, newValue) => setTabIndex(newValue)}
            sx={{ borderBottom: 1, borderColor: 'divider' }}
          >
            <Tab label="Users" />
            <Tab label="Allowlist" />
          </Tabs>

          <Box sx={{ p: 3 }}>
            <TabPanel value={tabIndex} index={0}>
              <UserList />
            </TabPanel>

            <TabPanel value={tabIndex} index={1}>
              {/* The DESTINATION gates on `users:read` (see
                  `config/destinations.ts`) because that is what makes this page
                  worth reaching. This TAB gates separately on `allowlist:read`,
                  because its data comes from a different controller
                  (`allowlist.controller.ts`) that enforces exactly that. A
                  destination gate is about reachability; a tab gate is about
                  content — collapsing the two would either hide the whole page
                  from someone entitled to the Users tab, or render a table that
                  can only 403. */}
              <RequirePermission
                permission="allowlist:read"
                fallback={
                  <Typography color="text.secondary">
                    You do not have permission to view the email allowlist.
                  </Typography>
                }
              >
                <AllowlistTable />
              </RequirePermission>
            </TabPanel>
          </Box>
        </Paper>
      </Box>
    </Container>
  );
}
