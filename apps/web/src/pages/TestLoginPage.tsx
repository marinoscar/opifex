import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Alert,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  useTheme,
} from '@mui/material';

export default function TestLoginPage() {
  const theme = useTheme();

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.palette.background.default,
        p: 2,
      }}
    >
      <Card
        sx={{
          maxWidth: 400,
          width: '100%',
          boxShadow: theme.shadows[10],
        }}
      >
        <CardContent sx={{ p: 4 }}>
          {/* Warning Banner */}
          <Alert severity="warning" sx={{ mb: 3 }}>
            Test Login - Development Only
          </Alert>

          {/* Header */}
          <Box sx={{ textAlign: 'center', mb: 3 }}>
            <Typography variant="h5" component="h1" sx={{ fontWeight: 'bold' }}>
              Test Authentication
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              Bypass OAuth for testing
            </Typography>
          </Box>

          {/* Form */}
          <form method="POST" action="/api/auth/test/login">
            <TextField
              name="email"
              label="Email"
              type="email"
              required
              fullWidth
              margin="normal"
              slotProps={{ htmlInput: { 'data-testid': 'test-email-input' } }}
            />

            <FormControl fullWidth margin="normal">
              <InputLabel>Role</InputLabel>
              <Select
                name="role"
                defaultValue="viewer"
                label="Role"
                data-testid="test-role-select"
              >
                <MenuItem value="admin">Admin</MenuItem>
                <MenuItem value="contributor">Contributor</MenuItem>
                <MenuItem value="viewer">Viewer</MenuItem>
              </Select>
            </FormControl>

            <TextField
              name="displayName"
              label="Display Name (optional)"
              fullWidth
              margin="normal"
            />

            <Button
              type="submit"
              variant="contained"
              fullWidth
              sx={{ mt: 3 }}
              data-testid="test-login-button"
            >
              Login as Test User
            </Button>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}
