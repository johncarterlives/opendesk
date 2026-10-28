import { describe, expect, it } from "vitest";
import { panelUrlOk, shopDomain, shopifyBody } from "./ticketPanels";

describe("ticket panel inputs", () => {
  it("reads a shop as the server does: a handle, its domain or an admin URL", () => {
    expect(shopDomain("lumen-store")).toBe("lumen-store.myshopify.com");
    expect(shopDomain(" Lumen-Store.myshopify.com/ ")).toBe("lumen-store.myshopify.com");
    expect(shopDomain("https://lumen-store.myshopify.com/admin/orders")).toBe("lumen-store.myshopify.com");
    expect(shopDomain("evil.example.com")).toBeNull();
    expect(shopDomain("lumen store")).toBeNull();
  });

  it("accepts https URLs, and http only on this machine", () => {
    expect(panelUrlOk("https://erp.example.com/panel?key=1")).toBe(true);
    expect(panelUrlOk("http://localhost:8080/panel")).toBe(true);
    expect(panelUrlOk("http://erp.example.com/panel")).toBe(false);
    expect(panelUrlOk("erp.example.com")).toBe(false);
  });

  it("saves a store with its app's client ID and secret, or a token, and nothing half given", () => {
    const empty = { clientId: "", clientSecret: "", token: "" };
    expect(shopifyBody({ ...empty, auth: "client_credentials", clientId: " app-id ", clientSecret: " s " })).toEqual({ client_id: "app-id", client_secret: "s" });
    expect(shopifyBody({ ...empty, auth: "client_credentials", clientId: "app-id", token: "shpat_x" })).toBeNull();
    expect(shopifyBody({ ...empty, auth: "access_token", clientId: "app-id", token: " shpat_x " })).toEqual({ token: "shpat_x" });
    expect(shopifyBody({ ...empty, auth: "access_token" })).toBeNull();
  });
});
