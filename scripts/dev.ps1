<#
.SYNOPSIS
    EnterpriseAppBase Development Script for Windows

.DESCRIPTION
    Manages the EnterpriseAppBase development environment using Docker Compose.
    Supports starting, stopping, rebuilding, viewing logs, running tests, and Prisma operations.

.PARAMETER Action
    The action to perform: start, stop, restart, rebuild, logs, status, clean, test, prisma, help

.PARAMETER Service
    Optional: Specific service to target (api, web, db, nginx)
    For test action: api, web, all, coverage, e2e, typecheck
    For prisma action: generate, migrate, studio, reset

.PARAMETER Otel
    Switch to include OpenTelemetry observability stack

.EXAMPLE
    .\dev.ps1 start
    Starts all services

.EXAMPLE
    .\dev.ps1 start -Otel
    Starts all services with OpenTelemetry observability stack

.EXAMPLE
    .\dev.ps1 rebuild
    Rebuilds and restarts all services

.EXAMPLE
    .\dev.ps1 logs api
    Shows logs for the API service

.EXAMPLE
    .\dev.ps1 test
    Runs all tests (API + Web)

.EXAMPLE
    .\dev.ps1 test api
    Runs API tests only

.EXAMPLE
    .\dev.ps1 test web ui
    Opens Vitest UI for frontend tests

.EXAMPLE
    .\dev.ps1 prisma migrate
    Runs Prisma migrations

.EXAMPLE
    .\dev.ps1 clean
    Stops services and removes volumes (resets database)
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "restart", "rebuild", "logs", "status", "clean", "test", "prisma", "help")]
    [string]$Action = "help",

    [Parameter(Position = 1)]
    [string]$Service = "",

    [Parameter(Position = 2)]
    [string]$ExtraArg = "",

    [switch]$Otel
)

$ErrorActionPreference = "Stop"

# Colors for output
function Write-Info { Write-Host $args -ForegroundColor Cyan }
function Write-Success { Write-Host $args -ForegroundColor Green }
function Write-Warn { Write-Host $args -ForegroundColor Yellow }
function Write-Err { Write-Host $args -ForegroundColor Red }

# Get the repository root (parent of scripts folder)
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ComposeDir = Join-Path $RepoRoot "infra\compose"
$BaseCompose = Join-Path $ComposeDir "base.compose.yml"
$DevCompose = Join-Path $ComposeDir "dev.compose.yml"
$OtelCompose = Join-Path $ComposeDir "otel.compose.yml"
$TestCompose = Join-Path $ComposeDir "test.compose.yml"
$ApiDir = Join-Path $RepoRoot "apps\api"
$WebDir = Join-Path $RepoRoot "apps\web"

# Verify compose files exist
if (-not (Test-Path $BaseCompose)) {
    Write-Err "ERROR: Base compose file not found at $BaseCompose"
    Write-Err "Make sure you're running this script from the EnterpriseAppBase repository."
    exit 1
}

function Show-Help {
    Write-Host ""
    Write-Info "EnterpriseAppBase Development Script"
    Write-Host "====================================="
    Write-Host ""
    Write-Host "Usage: .\dev.ps1 <action> [service/option] [-Otel]"
    Write-Host ""
    Write-Host "Actions:"
    Write-Host "  start     Start all services (or specific service)"
    Write-Host "  stop      Stop all services (or specific service)"
    Write-Host "  restart   Restart all services (or specific service)"
    Write-Host "  rebuild   Rebuild and restart all services (or specific service)"
    Write-Host "  logs      Show logs (follow mode). Optionally specify service"
    Write-Host "  status    Show status of all services"
    Write-Host "  test      Run tests. Options: api, web, all, coverage, e2e"
    Write-Host "  prisma    Prisma operations. Options: generate, migrate, studio, reset"
    Write-Host "  clean     Stop services and remove volumes (resets database)"
    Write-Host "  help      Show this help message"
    Write-Host ""
    Write-Host "Flags:"
    Write-Host "  -Otel     Include OpenTelemetry observability stack (Uptrace)"
    Write-Host ""
    Write-Host "Services: api, web, db, nginx"
    Write-Host ""
    Write-Host "Test Options:"
    Write-Host "  .\dev.ps1 test                 # Run type checks + unit tests (API + Web)"
    Write-Host "  .\dev.ps1 test all             # Run ALL tests (type checks + unit + E2E)"
    Write-Host "  .\dev.ps1 test typecheck       # Run type checks only"
    Write-Host "  .\dev.ps1 test api             # Run API tests (Jest)"
    Write-Host "  .\dev.ps1 test api watch       # Run API tests in watch mode"
    Write-Host "  .\dev.ps1 test api coverage    # Run API tests with coverage"
    Write-Host "  .\dev.ps1 test web             # Run Web tests (Vitest)"
    Write-Host "  .\dev.ps1 test web ui          # Open Vitest UI for Web tests"
    Write-Host "  .\dev.ps1 test web coverage    # Run Web tests with coverage"
    Write-Host "  .\dev.ps1 test e2e             # Run E2E tests (requires database)"
    Write-Host ""
    Write-Host "Prisma Options (runs in Docker):"
    Write-Host "  .\dev.ps1 prisma generate      # Generate Prisma client"
    Write-Host "  .\dev.ps1 prisma migrate       # Apply pending migrations"
    Write-Host "  .\dev.ps1 prisma migrate status # Check migration status"
    Write-Host "  .\dev.ps1 prisma push          # Push schema changes (dev, no migration file)"
    Write-Host "  .\dev.ps1 prisma studio        # Open Prisma Studio (local)"
    Write-Host "  .\dev.ps1 prisma seed          # Run database seed script"
    Write-Host "  .\dev.ps1 prisma reset         # Reset database (destroys data)"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\dev.ps1 start               # Start all services"
    Write-Host "  .\dev.ps1 start -Otel         # Start with observability stack"
    Write-Host "  .\dev.ps1 rebuild             # Rebuild and start all services"
    Write-Host "  .\dev.ps1 rebuild api         # Rebuild only the API service"
    Write-Host "  .\dev.ps1 logs api            # Follow API logs"
    Write-Host "  .\dev.ps1 test web ui         # Open Vitest UI in browser"
    Write-Host "  .\dev.ps1 status              # Show service status"
    Write-Host "  .\dev.ps1 clean               # Reset everything (destroys data)"
    Write-Host ""
    Write-Host "URLs (after start):"
    Write-Host "  Application:    http://localhost:3535"
    Write-Host "  API:            http://localhost:3535/api"
    Write-Host "  Swagger UI:     http://localhost:3535/api/docs"
    Write-Host "  API Health:     http://localhost:3535/api/health/live"
    Write-Host "  Uptrace:        http://localhost:14318 (with -Otel flag)"
    Write-Host ""
}

function Get-ComposeCommand {
    $cmd = "docker compose -f `"$BaseCompose`" -f `"$DevCompose`""
    if ($Otel) {
        $cmd += " -f `"$OtelCompose`""
    }
    return $cmd
}

function Invoke-DockerCompose {
    param([string[]]$Arguments)
    $baseCmd = Get-ComposeCommand
    $cmd = "$baseCmd $($Arguments -join ' ')"
    Write-Info "Running: $cmd"
    Push-Location $ComposeDir
    try {
        Invoke-Expression $cmd
    } finally {
        Pop-Location
    }
}

function Start-Services {
    Write-Info "Starting EnterpriseAppBase services..."
    if ($Otel) {
        Write-Info "Including OpenTelemetry observability stack..."
    }
    if ($Service) {
        Invoke-DockerCompose @("up", "-d", $Service)
    } else {
        Invoke-DockerCompose @("up", "-d")
    }
    Write-Success "Services started!"
    Write-Host ""
    Write-Info "Application:  http://localhost:3535"
    Write-Info "Swagger UI:   http://localhost:3535/api/docs"
    if ($Otel) {
        Write-Info "Uptrace:      http://localhost:14318"
    }
}

function Stop-Services {
    Write-Info "Stopping EnterpriseAppBase services..."
    if ($Service) {
        Invoke-DockerCompose @("stop", $Service)
    } else {
        Invoke-DockerCompose @("down")
    }
    Write-Success "Services stopped!"
}

function Restart-Services {
    Write-Info "Restarting EnterpriseAppBase services..."
    if ($Service) {
        Invoke-DockerCompose @("restart", $Service)
    } else {
        Invoke-DockerCompose @("down")
        Invoke-DockerCompose @("up", "-d")
    }
    Write-Success "Services restarted!"
}

function Rebuild-Services {
    Write-Info "Rebuilding EnterpriseAppBase services (no cache)..."
    if ($Otel) {
        Write-Info "Including OpenTelemetry observability stack..."
    }
    if ($Service) {
        Invoke-DockerCompose @("build", "--no-cache", $Service)
        Invoke-DockerCompose @("up", "-d", $Service)
    } else {
        Invoke-DockerCompose @("build", "--no-cache")
        Invoke-DockerCompose @("up", "-d")
    }
    Write-Success "Services rebuilt and started!"
    Write-Host ""
    Write-Info "Application:  http://localhost:3535"
    Write-Info "Swagger UI:   http://localhost:3535/api/docs"
    if ($Otel) {
        Write-Info "Uptrace:      http://localhost:14318"
    }
}

function Show-Logs {
    Write-Info "Showing logs (Ctrl+C to exit)..."
    if ($Service) {
        Invoke-DockerCompose @("logs", "-f", $Service)
    } else {
        Invoke-DockerCompose @("logs", "-f")
    }
}

function Show-Status {
    Write-Info "Service Status:"
    Invoke-DockerCompose @("ps")
}

function Clean-Services {
    Write-Warn "WARNING: This will stop all services and DELETE all data (database, volumes)!"
    $confirmation = Read-Host "Are you sure? Type 'yes' to confirm"
    if ($confirmation -eq "yes") {
        Write-Info "Cleaning up EnterpriseAppBase services and volumes..."
        Invoke-DockerCompose @("down", "-v")
        Write-Success "Cleanup complete! All data has been removed."
    } else {
        Write-Info "Cleanup cancelled."
    }
}

function Run-ApiTests {
    param([string]$Mode = "")

    Push-Location $ApiDir
    try {
        switch ($Mode.ToLower()) {
            "watch" {
                Write-Info "Running API tests in watch mode..."
                npm run test:watch
            }
            "coverage" {
                Write-Info "Running API tests with coverage..."
                npm run test:cov
            }
            "e2e" {
                Write-Info "Running API E2E tests..."
                npm run test:e2e
            }
            "unit" {
                Write-Info "Running API unit tests..."
                npm run test:unit
            }
            default {
                Write-Info "Running API tests..."
                npm test
            }
        }
    } finally {
        Pop-Location
    }
}

function Run-WebTests {
    param([string]$Mode = "")

    Push-Location $WebDir
    try {
        switch ($Mode.ToLower()) {
            "ui" {
                Write-Info "Opening Vitest UI for Web tests..."
                Write-Info "Test UI will be available at: http://localhost:51204/__vitest__/"
                npm run test:ui
            }
            "watch" {
                Write-Info "Running Web tests in watch mode..."
                npm run test:watch
            }
            "coverage" {
                Write-Info "Running Web tests with coverage..."
                npm run test:coverage
            }
            default {
                Write-Info "Running Web tests..."
                npm run test:run
            }
        }
    } finally {
        Pop-Location
    }
}

function Run-E2ETests {
    Write-Info "Running E2E tests..."

    # Start test database
    Write-Info "Starting test database..."
    Push-Location $ComposeDir
    try {
        docker compose -f "$TestCompose" up -d
        Start-Sleep -Seconds 3
    } finally {
        Pop-Location
    }

    # Run E2E tests from API
    Push-Location $ApiDir
    try {
        # Set individual database variables for test environment
        $env:POSTGRES_HOST = "localhost"
        $env:POSTGRES_PORT = "5433"
        $env:POSTGRES_USER = "postgres"
        $env:POSTGRES_PASSWORD = "postgres"
        $env:POSTGRES_DB = "enterprise_app_test"
        $env:POSTGRES_SSL = "false"
        npm run test:e2e
    } finally {
        Pop-Location
    }

    Write-Info "Stopping test database..."
    Push-Location $ComposeDir
    try {
        docker compose -f "$TestCompose" down
    } finally {
        Pop-Location
    }
}

function Run-TypeCheck {
    Write-Info "Running type checks..."

    # Type check API
    Write-Info "Type checking API..."
    Push-Location $ApiDir
    try {
        npx tsc --noEmit
        if ($LASTEXITCODE -ne 0) {
            Write-Err "API type check failed!"
            return $false
        }
        Write-Success "API type check passed!"
    } finally {
        Pop-Location
    }

    # Type check Web
    Write-Info "Type checking Web..."
    Push-Location $WebDir
    try {
        npx tsc --noEmit
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Web type check failed!"
            return $false
        }
        Write-Success "Web type check passed!"
    } finally {
        Pop-Location
    }

    Write-Success "All type checks passed!"
    Write-Host ""
    return $true
}

function Run-Tests {
    switch ($Service.ToLower()) {
        "api" {
            Run-ApiTests -Mode $ExtraArg
        }
        "web" {
            Run-WebTests -Mode $ExtraArg
        }
        "e2e" {
            Run-E2ETests
        }
        "coverage" {
            Write-Info "Running all tests with coverage..."
            Run-ApiTests -Mode "coverage"
            Write-Host ""
            Run-WebTests -Mode "coverage"
        }
        "typecheck" {
            Run-TypeCheck
        }
        "all" {
            Write-Info "Running ALL tests (type checks + unit + integration + E2E)..."

            # Run type checks first
            $typeCheckPassed = Run-TypeCheck
            if (-not $typeCheckPassed) {
                Write-Err "Type checks failed. Stopping."
                exit 1
            }

            # Run API unit tests
            Run-ApiTests
            if ($LASTEXITCODE -ne 0) {
                Write-Err "API tests failed. Stopping."
                exit 1
            }

            Write-Host ""

            # Run Web tests
            Run-WebTests
            if ($LASTEXITCODE -ne 0) {
                Write-Err "Web tests failed. Stopping."
                exit 1
            }

            Write-Host ""

            # Run E2E tests
            Run-E2ETests

            Write-Host ""
            Write-Success "All tests completed!"
        }
        default {
            Write-Info "Running all tests..."

            # Run type checks first
            $typeCheckPassed = Run-TypeCheck
            if (-not $typeCheckPassed) {
                Write-Err "Type checks failed. Stopping."
                exit 1
            }

            Run-ApiTests
            if ($LASTEXITCODE -eq 0) {
                Write-Host ""
                Run-WebTests
            } else {
                Write-Err "API tests failed. Stopping."
                exit 1
            }
        }
    }
}

function Invoke-PrismaInDocker {
    param([string]$Command)

    # Check if API container is running
    $containerName = "compose-api-1"
    $containerRunning = docker ps --filter "name=$containerName" --format "{{.Names}}" 2>$null

    if (-not $containerRunning) {
        Write-Err "ERROR: API container is not running."
        Write-Info "Start the services first with: .\dev.ps1 start"
        exit 1
    }

    Write-Info "Running in Docker container: $Command"
    # Use -t only (not -it) to avoid TTY issues on Windows
    docker exec $containerName sh -c $Command
    return $LASTEXITCODE
}

function Invoke-Prisma {
    switch ($Service.ToLower()) {
        "generate" {
            Write-Info "Generating Prisma client..."
            Invoke-PrismaInDocker "node scripts/prisma-env.js generate"
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Prisma client generated!"
            }
        }
        "migrate" {
            if ($ExtraArg.ToLower() -eq "deploy") {
                Write-Info "Applying migrations (production mode)..."
                Invoke-PrismaInDocker "node scripts/prisma-env.js migrate deploy"
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "Migrations applied!"
                }
            } elseif ($ExtraArg.ToLower() -eq "status") {
                Write-Info "Checking migration status..."
                Invoke-PrismaInDocker "node scripts/prisma-env.js migrate status"
            } else {
                Write-Info "Applying pending migrations..."
                Invoke-PrismaInDocker "node scripts/prisma-env.js migrate deploy"
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "Migrations applied!"
                    Write-Host ""
                    Write-Info "To seed the database, run: .\dev.ps1 prisma seed"
                }
            }
        }
        "push" {
            Write-Info "Pushing schema changes to database..."
            Invoke-PrismaInDocker "node scripts/prisma-env.js db push"
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Schema pushed successfully!"
            }
        }
        "studio" {
            Write-Info "Opening Prisma Studio..."
            Write-Info "Studio will be available at: http://localhost:5555"
            Write-Warn "Note: Studio runs locally (not in Docker) to allow browser access"
            Push-Location $ApiDir
            try {
                npm run prisma:studio
            } finally {
                Pop-Location
            }
        }
        "reset" {
            Write-Warn "WARNING: This will reset the database and DELETE all data!"
            $confirmation = Read-Host "Are you sure? Type 'yes' to confirm"
            if ($confirmation -eq "yes") {
                Write-Info "Resetting database..."
                Invoke-PrismaInDocker "node scripts/prisma-env.js migrate reset --force"
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "Database reset complete!"
                }
            } else {
                Write-Info "Reset cancelled."
            }
        }
        "seed" {
            Write-Info "Seeding database..."
            Invoke-PrismaInDocker "node scripts/prisma-env.js db seed"
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Database seeded!"
            }
        }
        default {
            Write-Host ""
            Write-Info "Prisma Commands (runs inside Docker)"
            Write-Host "====================================="
            Write-Host ""
            Write-Host "Usage: .\dev.ps1 prisma <command>"
            Write-Host ""
            Write-Host "Commands:"
            Write-Host "  generate       Generate Prisma client after schema changes"
            Write-Host "  migrate        Apply pending migrations to database"
            Write-Host "  migrate status Check migration status"
            Write-Host "  push           Push schema changes directly (dev, no migration file)"
            Write-Host "  studio         Open Prisma Studio GUI (runs locally)"
            Write-Host "  seed           Run database seed script"
            Write-Host "  reset          Reset database (destroys all data)"
            Write-Host ""
            Write-Host "Workflow:"
            Write-Host "  1. .\dev.ps1 prisma migrate    # Apply migrations"
            Write-Host "  2. .\dev.ps1 prisma seed       # Seed initial data"
            Write-Host ""
            Write-Host "Examples:"
            Write-Host "  .\dev.ps1 prisma migrate"
            Write-Host "  .\dev.ps1 prisma migrate status"
            Write-Host "  .\dev.ps1 prisma seed"
            Write-Host "  .\dev.ps1 prisma studio"
            Write-Host ""
            Write-Host "Note: Commands run inside the Docker API container to ensure"
            Write-Host "      proper database connectivity."
            Write-Host ""
        }
    }
}

# Main execution
switch ($Action) {
    "start"   { Start-Services }
    "stop"    { Stop-Services }
    "restart" { Restart-Services }
    "rebuild" { Rebuild-Services }
    "logs"    { Show-Logs }
    "status"  { Show-Status }
    "test"    { Run-Tests }
    "prisma"  { Invoke-Prisma }
    "clean"   { Clean-Services }
    "help"    { Show-Help }
    default   { Show-Help }
}
