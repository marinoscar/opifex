import { Box, Container, Typography, Grid } from '@mui/material';
import { UserProfileCard } from '../components/user/UserProfileCard';
import { QuickActions } from '../components/home/QuickActions';
import { useAuth } from '../contexts/AuthContext';

export default function HomePage() {
  const { user } = useAuth();

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {/* Welcome Header */}
        <Typography variant="h4" component="h1" gutterBottom>
          Welcome back{user?.displayName ? `, ${user.displayName}` : ''}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Your dashboard overview
        </Typography>

        <Grid container spacing={3}>
          {/* User Profile Card */}
          <Grid size={{ xs: 12, md: 4 }}>
            <UserProfileCard />
          </Grid>

          {/* Quick Actions */}
          <Grid size={{ xs: 12, md: 8 }}>
            <QuickActions />
          </Grid>
        </Grid>
      </Box>
    </Container>
  );
}
