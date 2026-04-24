import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

describe("App", () => {
  const originalClose = window.close;

  beforeEach(() => {
    vi.restoreAllMocks();
    (window as Window & { __LIVENESS_BOOTSTRAP_URL__?: string }).__LIVENESS_BOOTSTRAP_URL__ =
      "/bootstrap";
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
    window.close = originalClose;
    delete (window as Window & { __LIVENESS_BOOTSTRAP_URL__?: string }).__LIVENESS_BOOTSTRAP_URL__;
    delete (
      window as Window & {
        Telegram?: { WebApp?: { close?: () => void } };
      }
    ).Telegram;
  });

  it("shows an invalid-link state when no token is present", () => {
    window.history.replaceState({}, "", "/");

    render(<App />);

    expect(screen.getByRole("heading", { name: /invalid verification link/i })).toBeInTheDocument();
  });

  it("shows an error state when bootstrap fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 410,
      }),
    );
    window.history.replaceState({}, "", "/?token=abc");

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /verification could not continue/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/bootstrap failed with 410/i)).toBeInTheDocument();
  });

  it("can exercise the complete state in mock mode without calling AWS", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const telegramCloseSpy = vi.fn();
    (
      window as Window & {
        Telegram?: { WebApp?: { close?: () => void } };
      }
    ).Telegram = {
      WebApp: {
        close: telegramCloseSpy,
      },
    };
    window.history.replaceState({}, "", "/?mock=1");

    render(<App />);

    expect(screen.getByTestId("mock-detector")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /simulate success/i }));

    expect(screen.getByRole("heading", { name: /verification submitted/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /return to telegram/i }));

    expect(telegramCloseSpy).toHaveBeenCalled();
  });

  it("can exercise the detector error state in mock mode without calling AWS", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?mock=1");

    render(<App />);

    await user.click(screen.getByRole("button", { name: /simulate landscape error/i }));

    expect(
      screen.getByRole("heading", { name: /verification could not continue/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/rotate your device upright/i)).toBeInTheDocument();
  });
});
