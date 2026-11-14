// The IMAP folders a mailbox takes mail from (contracts/api.md "Mailboxes"): INBOX unless
// the admin picks others, such as folders the server's own rules file mail into. And the
// folder it keeps a copy of what it sends in, as a mail app does.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Row } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, type SelectOption } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import type { ImapFolder } from "@/lib/api/types";
import { qk } from "@/lib/queries";

export const IMAP_FOLDERS_MAX = 10;
const INBOX = "INBOX";

/** The folders a value reads: imap_folders, or INBOX alone when it is empty. */
export const foldersOf = (value: string[]) => (value.length ? value : [INBOX]);

/** What to store: INBOX alone is the default, stored empty. */
const toValue = (chosen: string[]) => (chosen.length === 1 && chosen[0] === INBOX ? [] : chosen);

/** Folders a server keeps for itself: reading them would turn sent mail, drafts or spam into tickets. All mail (Gmail's) holds the sent mail too. */
type NotMail = "sent" | "drafts" | "trash" | "junk" | "all";
const NOT_MAIL: readonly NotMail[] = ["sent", "drafts", "trash", "junk", "all"];
const notMail = (s: ImapFolder["special"]): s is NotMail => (NOT_MAIL as readonly string[]).includes(s);

export function ImapFoldersField({
  mailboxId,
  value,
  onChange,
  blocked,
}: {
  mailboxId: string;
  value: string[];
  onChange: (v: string[]) => void;
  /** Why the server cannot be asked now, such as unsaved server settings. */
  blocked?: string;
}) {
  const { t } = useTranslation("settingsChannels");
  const [open, setOpen] = useState(false);
  const chosen = foldersOf(value);
  const list = useQuery({
    queryKey: qk.mailboxImapFolders(mailboxId),
    queryFn: () => api.mailboxes.imapFolders(mailboxId),
    enabled: open && !blocked,
    staleTime: 60_000,
    retry: false,
  });
  const toggle = (name: string, on: boolean) => {
    const next = on ? [...chosen, name] : chosen.filter((x) => x !== name);
    // Never none: unticking the last folder goes back to INBOX.
    onChange(toValue(next.length ? next : [INBOX]));
  };
  // Shown by path (levels split by /) once the server listed them, else by name.
  const paths = new Map(list.data?.folders.map((f) => [f.name, f.path]));
  const label = (name: string) => (name === INBOX ? t("folders.inbox") : (paths.get(name) ?? name));
  const full = chosen.length >= IMAP_FOLDERS_MAX;

  return (
    <div className="flex flex-col gap-3 py-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {chosen.map((name) => (
          <Badge key={name} tone="outline" className="mono h-[22px] px-2 text-[11.5px] font-normal">
            {label(name)}
          </Badge>
        ))}
        <Tooltip content={blocked}>
          <span className="inline-flex">
            <Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} disabled={!!blocked} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? t("folders.done") : t("folders.choose")}
            </Button>
          </span>
        </Tooltip>
      </div>
      {open && !blocked && (
        <div className="animate-rise-in rounded-md border border-line motion-reduce:animate-none">
          {list.isPending && (
            <div className="flex flex-col gap-2 p-3" aria-busy>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-4 w-32" />
            </div>
          )}
          {list.isError && (
            <div className="flex items-start justify-between gap-3 p-3" role="alert">
              <div className="min-w-0 text-[12.5px]">
                <div className="font-medium text-tone-red">{t("folders.failed")}</div>
                <div className="mono mt-0.5 break-words text-xs text-fg-2">{errorMessage(list.error)}</div>
              </div>
              <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={list.isFetching} onClick={() => void list.refetch()}>
                {t("folders.retry")}
              </Button>
            </div>
          )}
          {list.data && (
            <ul className="max-h-72 overflow-y-auto py-1" aria-label={t("folders.title")}>
              {list.data.folders.map((f) => {
                const on = chosen.includes(f.name);
                const id = `imap-folder-${f.name}`;
                return (
                  <li key={f.name}>
                    <label htmlFor={id} className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[13px] hover:bg-hover has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
                      <Checkbox id={id} checked={on} disabled={!on && full} onCheckedChange={(v) => toggle(f.name, v)} />
                      <span className="mono min-w-0 flex-1 truncate">{label(f.name)}</span>
                      {notMail(f.special) && <Badge tone="amber">{t(`folders.special.${f.special}`)}</Badge>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {list.data && (
            <p className="border-t border-line-soft px-3 py-2 text-xs text-fg-3">{full ? t("folders.full", { max: IMAP_FOLDERS_MAX }) : t("folders.hint", { max: IMAP_FOLDERS_MAX })}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The folder a sent copy goes to by default: the server's Sent folder, else one named so. */
export function defaultSentFolder(folders: ImapFolder[]): string {
  return folders.find((f) => f.special === "sent")?.name ?? folders.find((f) => /^sent\b/i.test(f.path.split("/").pop() ?? ""))?.name ?? "Sent";
}

/**
 * Whether the mailbox keeps a copy of what it sends on its IMAP server, and in which
 * folder (imap_sent_folder; "" keeps none). Turning it on picks the server's Sent folder.
 */
export function SentFolderField({ mailboxId, value, onChange, blocked }: { mailboxId: string; value: string; onChange: (v: string) => void; blocked?: string }) {
  const { t } = useTranslation("settingsChannels");
  const on = value !== "";
  // Switched on before the folders arrived: the default is picked when they do.
  const [picking, setPicking] = useState(false);
  const list = useQuery({
    queryKey: qk.mailboxImapFolders(mailboxId),
    queryFn: () => api.mailboxes.imapFolders(mailboxId),
    enabled: (on || picking) && !blocked,
    staleTime: 60_000,
    retry: false,
  });
  const folders = list.data?.folders;
  useEffect(() => {
    if (picking && folders) {
      setPicking(false);
      onChange(defaultSentFolder(folders));
    }
  }, [picking, folders, onChange]);
  const toggle = (next: boolean) => {
    if (!next) {
      setPicking(false);
      onChange("");
    } else if (folders) onChange(defaultSentFolder(folders));
    else setPicking(true);
  };
  const options: SelectOption<string>[] = (folders ?? []).filter((f) => f.name !== INBOX).map((f) => ({ value: f.name, label: f.path }));
  if (on && !options.some((o) => o.value === value)) options.unshift({ value, label: value });

  return (
    <>
      <Row label={t("sentCopy.title")} description={t("sentCopy.hint")}>
        {(on || picking) && !blocked && (
          <Select
            size="sm"
            className="w-44"
            value={on ? value : undefined}
            onChange={onChange}
            options={options}
            placeholder={list.isPending ? t("sentCopy.loading") : t("sentCopy.choose")}
            disabled={!folders}
            aria-label={t("sentCopy.folder")}
          />
        )}
        <Tooltip content={blocked}>
          <span className="inline-flex">
            <Switch aria-label={t("sentCopy.title")} checked={on || picking} disabled={!!blocked} onCheckedChange={toggle} />
          </span>
        </Tooltip>
      </Row>
      {(on || picking) && list.isError && (
        <div className="flex items-start justify-between gap-3 pb-3.5" role="alert">
          <div className="min-w-0 text-[12.5px]">
            <div className="font-medium text-tone-red">{t("folders.failed")}</div>
            <div className="mono mt-0.5 break-words text-xs text-fg-2">{errorMessage(list.error)}</div>
          </div>
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={list.isFetching} onClick={() => void list.refetch()}>
            {t("folders.retry")}
          </Button>
        </div>
      )}
    </>
  );
}
