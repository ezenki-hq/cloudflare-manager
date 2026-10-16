package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/auth"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/cloudflare"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/server"
)

const (
	defaultAuthorizationURL = "https://dash.cloudflare.com/oauth2/auth"
	defaultTokenURL         = "https://dash.cloudflare.com/oauth2/token"
	defaultPort             = "8080"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		if err := healthcheck(os.Getenv("PORT")); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := serve(); err != nil {
		log.Fatal(err)
	}
}

func serve() error {
	clientID := strings.TrimSpace(os.Getenv("CF_CLIENT_ID"))
	publicOrigin := strings.TrimRight(strings.TrimSpace(os.Getenv("PUBLIC_ORIGIN")), "/")
	commanderOrigin := strings.TrimRight(strings.TrimSpace(os.Getenv("COMMANDER_ORIGIN")), "/")
	if clientID == "" || publicOrigin == "" || commanderOrigin == "" {
		return fmt.Errorf("CF_CLIENT_ID, PUBLIC_ORIGIN, and COMMANDER_ORIGIN are required")
	}
	oauth, err := auth.NewHandler(auth.Config{
		ClientID: clientID, PublicOrigin: publicOrigin, CommanderOrigin: commanderOrigin,
		AuthorizationURL: defaultAuthorizationURL, TokenURL: defaultTokenURL,
	}, &http.Client{Timeout: 12 * time.Second}, time.Now)
	if err != nil {
		return fmt.Errorf("configure OAuth: %w", err)
	}
	api := cloudflare.NewClient("https://api.cloudflare.com", &http.Client{Timeout: 20 * time.Second})
	handler := server.NewHandler(server.Config{PublicOrigin: publicOrigin, CommanderOrigin: commanderOrigin, StaticDir: os.Getenv("STATIC_DIR")}, oauth, api)
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
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
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
