"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { AlertCircle, Loader2, TriangleAlert, Youtube } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { warnIfWorkerOffline } from "@/lib/worker-notice";

/** `GET /api/youtube/account` (design §4.8). Tokens never appear here. */
type YoutubeAccount = {
  configured: boolean;
  connected: boolean;
  channel: { id: string; title: string; handle: string | null; thumbnail_url: string | null } | null;
  status: "active" | "reauth_required" | "paused" | null;
  warning: "private_lock" | null;
  auto_post: boolean;
  privacy: "public" | "unlisted" | "private";
  made_for_kids: boolean;
  add_to_playlist: boolean;
  link_full_video: boolean;
  /** False: the connection predates playlists, so turning them on needs a reconnect. */
  playlist_access: boolean;
};

const ERROR_CODES = ["denied", "expired", "missing_scope", "no_channel", "exchange_failed", "not_configured"] as const;

/** Settings → YouTube auto-post (design §4.8), shown to every user. */
export function YoutubeSettings() {
  const t = useTranslations("settings.youtube");
  const common = useTranslations("common");
  const searchParams = useSearchParams();
  const [account, setAccount] = useState<YoutubeAccount | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  useEffect(() => {
    void fetch("/api/youtube/account", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: YoutubeAccount | null) => data && setAccount(data))
      .catch(() => {});
  }, []);

  const connectedParam = searchParams.get("youtube") === "connected";
  useEffect(() => {
    if (connectedParam) toast.success(t("connectedToast"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedParam]);

  /** `playlists` also asks Google for permission to manage playlists. */
  const connect = async (playlists = false) => {
    setConnecting(true);
    try {
      const response = await fetch("/api/youtube/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playlists: playlists || account?.add_to_playlist === true }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.authorize_url) throw new Error();
      window.location.href = data.authorize_url;
    } catch {
      toast.error(t("connectFailed"));
      setConnecting(false);
    }
  };

  const resume = async () => {
    setResuming(true);
    try {
      const response = await fetch("/api/youtube/account/resume", { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error();
      setAccount(data);
      warnIfWorkerOffline(data);
    } catch {
      toast.error(t("resumeFailed"));
    } finally {
      setResuming(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      const response = await fetch("/api/youtube/account", { method: "DELETE" });
      if (!response.ok) throw new Error();
      setAccount((prev) => (prev ? { ...prev, connected: false, channel: null, status: null, warning: null } : prev));
      setDisconnectOpen(false);
    } catch {
      toast.error(t("disconnectFailed"));
    } finally {
      setDisconnecting(false);
    }
  };

  const updatePrefs = async (
    body: Partial<Pick<YoutubeAccount, "auto_post" | "privacy" | "made_for_kids" | "add_to_playlist" | "link_full_video">>,
  ) => {
    if (!account) return;
    const previous = account;
    setAccount({ ...account, ...body });
    try {
      const response = await fetch("/api/youtube/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error();
      setAccount(data);
    } catch {
      setAccount(previous);
      toast.error(t("saveFailed"));
    }
  };

  if (!account) return <p className="text-sm text-muted-foreground">{t("loading")}</p>;

  const errorCode = searchParams.get("youtube_error");
  const errorMessage = errorCode ? t(ERROR_CODES.includes(errorCode as (typeof ERROR_CODES)[number]) ? `errors.${errorCode}` : "errors.unknown") : null;

  return (
    <div className="space-y-5">
      {errorMessage && (
        <Alert className="border-red-200 bg-red-50">
          <AlertCircle className="h-4 w-4 text-red-500" />
          <AlertDescription className="text-sm text-red-700">{errorMessage}</AlertDescription>
        </Alert>
      )}

      {!account.configured && (
        <div className="space-y-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          <p>
            {t.rich("setupHint", { code: (chunks) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{chunks}</code> })}
          </p>
        </div>
      )}

      {account.configured && !account.connected && (
        <Button type="button" onClick={() => void connect()} disabled={connecting}>
          {connecting ? <Loader2 className="size-4 animate-spin" /> : <Youtube className="size-4" />}
          {connecting ? t("connecting") : t("connect")}
        </Button>
      )}

      {account.connected && account.channel && (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/60 px-4 py-3">
            {account.channel.thumbnail_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={account.channel.thumbnail_url} alt="" className="size-10 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
                <Youtube className="size-5" />
              </span>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{account.channel.title}</p>
              {account.channel.handle && <p className="truncate text-xs text-muted-foreground">{account.channel.handle}</p>}
            </div>
          </div>

          {account.status === "reauth_required" && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <span className="flex items-center gap-2"><TriangleAlert className="size-4 shrink-0" />{t("reauthRequired")}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => void connect()} disabled={connecting}>
                {connecting ? t("connecting") : t("reconnect")}
              </Button>
            </div>
          )}

          {account.warning === "private_lock" && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <span className="flex items-center gap-2"><TriangleAlert className="size-4 shrink-0" />{t("privateLock")}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => void resume()} disabled={resuming}>
                {resuming ? t("resuming") : t("resume")}
              </Button>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="youtube-autopost" className="text-sm">{t("autoPostLabel")}</Label>
            <Switch id="youtube-autopost" checked={account.auto_post} onCheckedChange={(checked) => void updatePrefs({ auto_post: checked })} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-sm">{t("visibility")}</Label>
              <Select value={account.privacy} onValueChange={(value) => void updatePrefs({ privacy: value as YoutubeAccount["privacy"] })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">{t("visibilityPublic")}</SelectItem>
                  <SelectItem value="unlisted">{t("visibilityUnlisted")}</SelectItem>
                  <SelectItem value="private">{t("visibilityPrivate")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-sm">{t("madeForKids")}</Label>
              <Select value={account.made_for_kids ? "yes" : "no"} onValueChange={(value) => void updatePrefs({ made_for_kids: value === "yes" })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="no">{t("madeForKidsNo")}</SelectItem>
                  <SelectItem value="yes">{t("madeForKidsYes")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3 border-t pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <Label htmlFor="youtube-playlist" className="text-sm">{t("playlistLabel")}</Label>
                <p className="text-xs text-muted-foreground">{t("playlistHint")}</p>
              </div>
              <Switch id="youtube-playlist" checked={account.add_to_playlist} onCheckedChange={(checked) => void updatePrefs({ add_to_playlist: checked })} />
            </div>
            {account.add_to_playlist && !account.playlist_access && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                <span className="flex items-center gap-2"><TriangleAlert className="size-4 shrink-0" />{t("playlistNeedsAccess")}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => void connect(true)} disabled={connecting}>
                  {connecting ? t("connecting") : t("allowPlaylists")}
                </Button>
              </div>
            )}
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <Label htmlFor="youtube-full-video" className="text-sm">{t("fullVideoLabel")}</Label>
                <p className="text-xs text-muted-foreground">{t("fullVideoHint")}</p>
              </div>
              <Switch id="youtube-full-video" checked={account.link_full_video} onCheckedChange={(checked) => void updatePrefs({ link_full_video: checked })} />
            </div>
          </div>

          <div className="flex justify-end">
            <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="ghost">{t("disconnect")}</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("disconnectTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("disconnectBody")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={disconnecting}>{common("cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void disconnect()} disabled={disconnecting} className="bg-red-600 hover:bg-red-700">
                    {disconnecting ? t("disconnecting") : t("disconnect")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </>
      )}

      {account.configured && (
        <p className="border-t pt-4 text-xs text-muted-foreground">
          {t("policyIntro")}{" "}
          <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">{t("tos")}</a>
          {", "}
          <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">{t("privacyPolicy")}</a>
          {", "}
          <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">{t("permissions")}</a>
        </p>
      )}
    </div>
  );
}
