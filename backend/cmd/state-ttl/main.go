package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/auth"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/commander"
)

func main() {
	if err := run(context.Background(), os.Getenv, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, getenv func(string) string, stdout io.Writer) error {
	managerID := strings.TrimSpace(getenv("MANAGER_ID"))
	managerAPI := strings.TrimRight(strings.TrimSpace(getenv("MANAGER_API")), "/")
	managerPassword := getenv("MANAGER_PASSWORD")
	if managerID == "" || managerAPI == "" || managerPassword == "" {
		return errors.New("MANAGER_ID, MANAGER_API, and MANAGER_PASSWORD are required")
	}
	client, err := commander.NewClient(managerAPI, managerID, managerPassword, &http.Client{Timeout: 12 * time.Second})
	if err != nil {
		return errors.New("Commander configuration is invalid")
	}
	verifyCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	err = client.VerifyManager(verifyCtx)
	cancel()
	if err != nil {
		return fmt.Errorf("verify Commander manager: %w", err)
	}
	store, err := auth.NewPendingStore(client, managerID, managerPassword)
	if err != nil {
		return errors.New("OAuth state cleanup could not be configured")
	}
	pruneCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	count, err := store.Prune(pruneCtx, time.Now())
	cancel()
	if err != nil {
		return fmt.Errorf("prune expired OAuth states: %w", err)
	}
	_, err = fmt.Fprintf(stdout, "Removed %d expired OAuth states.\n", count)
	return err
}
