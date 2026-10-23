package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/auth"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/cloudflare"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/commander"
	managerjwt "github.com/ezenki-hq/cloudflare-manager/backend/internal/jwt"
	managerpkg "github.com/ezenki-hq/cloudflare-manager/backend/internal/manager"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/server"
)

const (
	defaultAuthorizationURL = "https://dash.cloudflare.com/oauth2/auth"
	defaultTokenURL         = "https://dash.cloudflare.com/oauth2/token"
	defaultPort             = "8080"
)

func main() {
	if err := runCommand(os.Args[1:], os.Stdout); err != nil {
		log.Fatal(err)
	}
}

func runCommand(args []string, stdout io.Writer) error {
	if len(args) > 0 && args[0] == "generate-jwt-secret" {
		if len(args) != 1 {
			return fmt.Errorf("generate-jwt-secret takes no arguments")
		}
		secret, err := managerjwt.GenerateSecret()
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(stdout, secret)
		return err
	}
	if len(args) > 0 && args[0] == "healthcheck" {
		if len(args) != 1 {
			return fmt.Errorf("healthcheck takes no arguments")
		}
		return healthcheck(os.Getenv("PORT"))
	}
	return serve()
}

func serve() error {
	managerID := strings.TrimSpace(os.Getenv("MANAGER_ID"))
	managerAPI := strings.TrimRight(strings.TrimSpace(os.Getenv("MANAGER_API")), "/")
	managerPassword := os.Getenv("MANAGER_PASSWORD")
	encodedSecret := strings.TrimSpace(os.Getenv("JWT_SECRET"))
	if managerID == "" || managerAPI == "" || managerPassword == "" || encodedSecret == "" {
		return fmt.Errorf("MANAGER_ID, MANAGER_API, MANAGER_PASSWORD, and JWT_SECRET are required")
	}
	jwtSecret, err := base64.RawURLEncoding.DecodeString(encodedSecret)
	if err != nil || len(jwtSecret) != 32 {
		return fmt.Errorf("JWT_SECRET must be an unpadded base64url value containing 32 bytes")
	}
	slog.Info("Cloudflare Manager startup", "stage", "configuration_validated")
	commanderClient, err := commander.NewClient(managerAPI, managerID, managerPassword, &http.Client{Timeout: 12 * time.Second})
	if err != nil {
		return fmt.Errorf("configure Commander: %w", err)
	}
	verifyCtx, verifyCancel := context.WithTimeout(context.Background(), 12*time.Second)
	slog.Info("Cloudflare Manager startup", "stage", "commander_verification_started")
	err = prepareCommander(verifyCtx, managerID, commanderClient)
	verifyCancel()
	if err != nil {
		return err
	}
	stateStore, err := auth.NewPendingStore(commanderClient, managerID, managerPassword)
	if err != nil {
		return fmt.Errorf("configure OAuth state store: %w", err)
	}
	oauth, err := auth.NewHandler(auth.Config{AuthorizationURL: defaultAuthorizationURL, TokenURL: defaultTokenURL, StateStore: stateStore, ManagerID: managerID}, &http.Client{Timeout: 12 * time.Second}, time.Now)
	if err != nil {
		return fmt.Errorf("configure OAuth: %w", err)
	}
	api := cloudflare.NewClient("https://api.cloudflare.com", &http.Client{Timeout: 20 * time.Second})
	handler := server.NewHandler(server.Config{ManagerID: managerID, JWTSecret: jwtSecret, StaticDir: os.Getenv("STATIC_DIR")}, oauth, api, commanderClient)
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = defaultPort
	}
	if _, err := strconv.Atoi(port); err != nil {
		return fmt.Errorf("PORT must be numeric")
	}
	httpServer := &http.Server{Addr: ":" + port, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	slog.Info("Cloudflare Manager startup", "stage", "http_listener_starting")
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func prepareCommander(ctx context.Context, managerID string, client *commander.Client) error {
	if err := client.VerifyManager(ctx); err != nil {
		return fmt.Errorf("verify Commander manager: %w", err)
	}
	slog.Info("Cloudflare Manager startup", "stage", "commander_verified")
	if _, err := managerpkg.NewService(managerID, client, nil).EnsureServiceResource(ctx); err != nil {
		return fmt.Errorf("ensure S3 service resource: %w", err)
	}
	return nil
}

func healthcheck(port string) error {
	if port == "" {
		port = defaultPort
	}
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return fmt.Errorf("manager health check failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("manager health check returned status %d", resp.StatusCode)
	}
	return nil
}
