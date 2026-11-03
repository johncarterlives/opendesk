export type PortalConfig = { title: string; logo_url: string; color: string; locale: string; locale_fixed: boolean; help_url: string };
export type CustomerTicket = { id: string; number: number; subject: string; status: string; created_at: string; updated_at: string };
export type CustomerMessage = { id: string; direction: "inbound" | "outbound"; body_text: string; created_at: string };
export type Page<T> = { data: T[]; next_cursor: string | null };
export type CustomerToken = { access_token: string; expires_at: string };
export type CustomerLogin = (CustomerToken & { change_password?: false }) | { change_password: true };
