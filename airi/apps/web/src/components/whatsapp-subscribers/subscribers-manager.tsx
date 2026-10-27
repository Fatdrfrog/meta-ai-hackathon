"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Copy,
  Download,
  Link as LinkIcon,
  Plus,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import QRCodeLib from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

type SignupLink = {
  id: string;
  metaSignupId: string;
  deepLinkUrl: string;
  displayName: string | null;
  signupMessage: string;
  confirmationMessage: string;
  privacyPolicyUrl: string;
  websiteUrl: string | null;
  promoCode: string | null;
  status: "ACTIVE" | "DISABLED";
  productLine: string | null;
  shop: string | null;
  campaign: string | null;
  landingPage: string | null;
  ad: string | null;
  checkoutFlow: string | null;
  messagingCustomerBaseId: string | null;
  createdAt?: string | null;
};

type Subscriber = {
  id: string;
  waId: string | null;
  userId: string | null;
  status: boolean;
  source: string;
  metaSignupId: string | null;
  messagingCustomerBaseId: string | null;
  productLine: string | null;
  shop: string | null;
  campaign: string | null;
  landingPage: string | null;
  ad: string | null;
  checkoutFlow: string | null;
  eventAt: string | null;
  receivedAt: string | null;
};

type CustomerBase = {
  id: string;
  metaCustomerBaseId: string;
  name: string;
  isDefault: boolean;
};

type LinkForm = {
  displayName: string;
  signupMessage: string;
  confirmationMessage: string;
  privacyPolicyUrl: string;
  websiteUrl: string;
  promoCode: string;
  productLine: string;
  shop: string;
  campaign: string;
  landingPage: string;
  ad: string;
  checkoutFlow: string;
  messagingCustomerBaseId: string;
};

type BaseForm = {
  name: string;
};

const optionalUrlFormField = z
  .string()
  .trim()
  .refine(value => {
    if (!value) return true;
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }, "Enter a valid URL");

const linkFormSchema = z.object({
  displayName: z.string().trim().max(160),
  signupMessage: z.string().trim().min(1).max(2000),
  confirmationMessage: z.string().trim().min(1).max(2000),
  privacyPolicyUrl: z.string().trim().url().max(2048),
  websiteUrl: optionalUrlFormField,
  promoCode: z.string().trim().max(160),
  productLine: z.string().trim().max(160),
  shop: z.string().trim().max(160),
  campaign: z.string().trim().max(160),
  landingPage: z.string().trim().max(240),
  ad: z.string().trim().max(240),
  checkoutFlow: z.string().trim().max(160),
  messagingCustomerBaseId: z.string().trim().max(160),
}) satisfies z.ZodType<LinkForm>;

const baseFormSchema = z.object({
  name: z.string().trim().min(1).max(160),
}) satisfies z.ZodType<BaseForm>;

const emptyLinkForm: LinkForm = {
  displayName: "",
  signupMessage: "",
  confirmationMessage: "",
  privacyPolicyUrl: "",
  websiteUrl: "",
  promoCode: "",
  productLine: "",
  shop: "",
  campaign: "",
  landingPage: "",
  ad: "",
  checkoutFlow: "",
  messagingCustomerBaseId: "",
};

function formatDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function trimForm(form: LinkForm) {
  return Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, value.trim()])
  );
}

function attributionSummary(item: {
  productLine?: string | null;
  shop?: string | null;
  campaign?: string | null;
  landingPage?: string | null;
  ad?: string | null;
  checkoutFlow?: string | null;
}) {
  return [
    item.productLine,
    item.shop,
    item.campaign,
    item.landingPage,
    item.ad,
    item.checkoutFlow,
  ]
    .filter(Boolean)
    .join(" / ");
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string" ? body.error : "Request failed"
    );
  }
  return body as T;
}

export function WhatsAppSubscribersManager({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const t = useTranslations("WhatsAppSubscribers");
  const [links, setLinks] = useState<SignupLink[]>([]);
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [bases, setBases] = useState<CustomerBase[]>([]);
  const [qrByLinkId, setQrByLinkId] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingLink, setSavingLink] = useState(false);
  const [savingBase, setSavingBase] = useState(false);
  const [actionLinkId, setActionLinkId] = useState<string | null>(null);
  const [actionBaseId, setActionBaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const defaultLinkFormValues = useMemo<LinkForm>(
    () => ({
      ...emptyLinkForm,
      signupMessage: t("defaults.signupMessage"),
      confirmationMessage: t("defaults.confirmationMessage"),
    }),
    [t]
  );
  const linkForm = useForm<LinkForm>({
    resolver: zodResolver(linkFormSchema),
    defaultValues: defaultLinkFormValues,
  });
  const baseForm = useForm<BaseForm>({
    resolver: zodResolver(baseFormSchema),
    defaultValues: { name: "" },
  });

  const activeLinks = useMemo(
    () => links.filter(link => link.status === "ACTIVE").length,
    [links]
  );
  const optedInCount = useMemo(
    () => subscribers.filter(item => item.status).length,
    [subscribers]
  );

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ workspaceId });
      const [linksBody, subscribersBody, basesBody] = await Promise.all([
        fetch(`/api/whatsapp/signups?${query.toString()}`).then(response =>
          readJson<{ links?: SignupLink[] }>(response)
        ),
        fetch(`/api/whatsapp/subscribers?${query.toString()}`).then(response =>
          readJson<{ subscribers?: Subscriber[] }>(response)
        ),
        fetch(
          `/api/whatsapp/messaging-customer-bases?${query.toString()}`
        ).then(response => readJson<{ bases?: CustomerBase[] }>(response)),
      ]);
      setLinks(Array.isArray(linksBody.links) ? linksBody.links : []);
      setSubscribers(
        Array.isArray(subscribersBody.subscribers)
          ? subscribersBody.subscribers
          : []
      );
      setBases(Array.isArray(basesBody.bases) ? basesBody.bases : []);
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : t("errors.load");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [t, workspaceId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    let cancelled = false;
    async function generateQrCodes() {
      const entries = await Promise.all(
        links.map(async link => {
          const dataUrl = await QRCodeLib.toDataURL(link.deepLinkUrl, {
            width: 220,
            margin: 2,
          });
          return [link.id, dataUrl] as const;
        })
      );
      if (!cancelled) {
        setQrByLinkId(Object.fromEntries(entries));
      }
    }

    if (links.length > 0) {
      generateQrCodes().catch(() => undefined);
    } else {
      setQrByLinkId({});
    }

    return () => {
      cancelled = true;
    };
  }, [links]);

  const createLink = async (values: LinkForm) => {
    setSavingLink(true);
    setError(null);
    try {
      const body = trimForm(values);
      const result = await fetch("/api/whatsapp/signups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, ...body }),
      }).then(response => readJson<{ link: SignupLink }>(response));
      setLinks(prev => [result.link, ...prev]);
      linkForm.reset(defaultLinkFormValues);
      toast.success(t("toasts.signupCreated"));
    } catch (createError) {
      const message =
        createError instanceof Error
          ? createError.message
          : t("errors.createSignup");
      setError(message);
      toast.error(message);
    } finally {
      setSavingLink(false);
    }
  };

  const createBase = async (values: BaseForm) => {
    setSavingBase(true);
    setError(null);
    try {
      const result = await fetch("/api/whatsapp/messaging-customer-bases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, name: values.name.trim() }),
      }).then(response => readJson<{ base: CustomerBase }>(response));
      setBases(prev => [result.base, ...prev]);
      baseForm.reset({ name: "" });
      toast.success(t("toasts.baseCreated"));
    } catch (createError) {
      const message =
        createError instanceof Error
          ? createError.message
          : t("errors.createBase");
      setError(message);
      toast.error(message);
    } finally {
      setSavingBase(false);
    }
  };

  const disableLink = async (link: SignupLink) => {
    setActionLinkId(link.id);
    try {
      const result = await fetch(`/api/whatsapp/signups/${link.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, status: "DISABLED" }),
      }).then(response => readJson<{ link: SignupLink }>(response));
      setLinks(prev =>
        prev.map(item => (item.id === link.id ? result.link : item))
      );
      toast.success(t("toasts.signupDisabled"));
    } catch (disableError) {
      const message =
        disableError instanceof Error
          ? disableError.message
          : t("errors.disableSignup");
      toast.error(message);
    } finally {
      setActionLinkId(null);
    }
  };

  const setDefaultBase = async (base: CustomerBase) => {
    setActionBaseId(base.id);
    try {
      await fetch("/api/whatsapp/messaging-customer-bases/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          customerBaseId: base.metaCustomerBaseId,
        }),
      }).then(response => readJson<{ customerBaseId: string }>(response));
      setBases(prev =>
        prev.map(item => ({
          ...item,
          isDefault: item.metaCustomerBaseId === base.metaCustomerBaseId,
        }))
      );
      toast.success(t("toasts.defaultBaseUpdated"));
    } catch (defaultError) {
      const message =
        defaultError instanceof Error
          ? defaultError.message
          : t("errors.setDefaultBase");
      toast.error(message);
    } finally {
      setActionBaseId(null);
    }
  };

  const copyText = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(t("toasts.copied", { label }));
  };

  const downloadQr = (link: SignupLink) => {
    const dataUrl = qrByLinkId[link.id];
    if (!dataUrl) return;
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = `${link.displayName || link.metaSignupId}-whatsapp-qr.png`;
    anchor.click();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <LinkIcon className="h-4 w-4" />
              {t("stats.links")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {loading ? <Skeleton className="h-8 w-12" /> : activeLinks}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              {t("stats.optedIn")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {loading ? <Skeleton className="h-8 w-12" /> : optedInCount}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              {t("stats.customerBases")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {loading ? <Skeleton className="h-8 w-12" /> : bases.length}
          </CardContent>
        </Card>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end">
        <Button variant="outline" onClick={loadAll} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t("actions.refresh")}
        </Button>
      </div>

      <Tabs defaultValue="links" className="flex flex-col gap-4">
        <TabsList className="w-fit">
          <TabsTrigger value="links">{t("tabs.links")}</TabsTrigger>
          <TabsTrigger value="subscribers">{t("tabs.subscribers")}</TabsTrigger>
          <TabsTrigger value="bases">{t("tabs.bases")}</TabsTrigger>
        </TabsList>

        <TabsContent value="links" className="mt-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("createLink.title")}</CardTitle>
              <CardDescription>{t("createLink.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...linkForm}>
                <form
                  onSubmit={linkForm.handleSubmit(createLink)}
                  className="grid gap-4"
                >
                  <div className="grid gap-4 md:grid-cols-2">
                    <FormField
                      control={linkForm.control}
                      name="displayName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("fields.displayName")}</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              placeholder={t("placeholders.displayName")}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={linkForm.control}
                      name="privacyPolicyUrl"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("fields.privacyPolicyUrl")}</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              placeholder="https://example.com/privacy"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={linkForm.control}
                      name="signupMessage"
                      render={({ field }) => (
                        <FormItem className="md:col-span-2">
                          <FormLabel>{t("fields.signupMessage")}</FormLabel>
                          <FormControl>
                            <Textarea {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={linkForm.control}
                      name="confirmationMessage"
                      render={({ field }) => (
                        <FormItem className="md:col-span-2">
                          <FormLabel>
                            {t("fields.confirmationMessage")}
                          </FormLabel>
                          <FormControl>
                            <Textarea {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={linkForm.control}
                      name="websiteUrl"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("fields.websiteUrl")}</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              placeholder="https://example.com"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={linkForm.control}
                      name="promoCode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("fields.promoCode")}</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="FLASH30" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    {(
                      [
                        ["productLine", "fields.productLine"],
                        ["shop", "fields.shop"],
                        ["campaign", "fields.campaign"],
                        ["landingPage", "fields.landingPage"],
                        ["ad", "fields.ad"],
                        ["checkoutFlow", "fields.checkoutFlow"],
                      ] as const
                    ).map(([key, labelKey]) => (
                      <FormField
                        key={key}
                        control={linkForm.control}
                        name={key}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t(labelKey)}</FormLabel>
                            <FormControl>
                              <Input {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    ))}
                  </div>

                  <div className="flex justify-end">
                    <Button type="submit" disabled={savingLink}>
                      <Plus className="mr-2 h-4 w-4" />
                      {savingLink
                        ? t("actions.creatingLink")
                        : t("actions.createLink")}
                    </Button>
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            {loading ? (
              Array.from({ length: 2 }, (_, index) => (
                <Card key={index}>
                  <CardHeader>
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-4 w-56" />
                  </CardHeader>
                  <CardContent className="grid gap-4 sm:grid-cols-[160px_1fr]">
                    <Skeleton className="h-40 w-40" />
                    <div className="space-y-3">
                      <Skeleton className="h-9 w-full" />
                      <div className="flex gap-2">
                        <Skeleton className="h-9 w-24" />
                        <Skeleton className="h-9 w-24" />
                        <Skeleton className="h-9 w-16" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            ) : links.length === 0 ? (
              <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">
                  {t("empty.links")}
                </CardContent>
              </Card>
            ) : (
              links.map(link => {
                const embed = `<a href="${link.deepLinkUrl}" target="_blank" rel="noopener">${t("embedCta")}</a>`;
                return (
                  <Card key={link.id}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <CardTitle className="text-base">
                            {link.displayName || link.metaSignupId}
                          </CardTitle>
                          <CardDescription>
                            {attributionSummary(link) || t("empty.attribution")}
                          </CardDescription>
                        </div>
                        <Badge
                          variant={
                            link.status === "ACTIVE" ? "default" : "secondary"
                          }
                        >
                          {link.status}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="grid gap-4 sm:grid-cols-[160px_1fr]">
                      <div className="flex h-40 w-40 items-center justify-center rounded-md border bg-white">
                        {qrByLinkId[link.id] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={qrByLinkId[link.id]}
                            alt={t("qrAlt")}
                            className="h-36 w-36"
                          />
                        ) : (
                          <QrCode className="h-8 w-8 text-muted-foreground" />
                        )}
                      </div>
                      <div className="flex min-w-0 flex-col gap-3">
                        <p className="break-all rounded-md bg-muted px-3 py-2 text-xs">
                          {link.deepLinkUrl}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              copyText(link.deepLinkUrl, t("copyLabels.link"))
                            }
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            {t("actions.copyLink")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              copyText(embed, t("copyLabels.embed"))
                            }
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            {t("actions.copyEmbed")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => downloadQr(link)}
                          >
                            <Download className="mr-2 h-4 w-4" />
                            {t("actions.qr")}
                          </Button>
                          {link.status === "ACTIVE" && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={actionLinkId === link.id}
                              onClick={() => disableLink(link)}
                            >
                              {t("actions.disable")}
                            </Button>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t("created", { date: formatDate(link.createdAt) })}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </TabsContent>

        <TabsContent value="subscribers" className="mt-0">
          <Card>
            <CardHeader>
              <CardTitle>{t("subscribers.title")}</CardTitle>
              <CardDescription>{t("subscribers.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("table.user")}</TableHead>
                    <TableHead>{t("table.status")}</TableHead>
                    <TableHead>{t("table.source")}</TableHead>
                    <TableHead>{t("table.attribution")}</TableHead>
                    <TableHead>{t("table.eventTime")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    Array.from({ length: 3 }, (_, index) => (
                      <TableRow key={index}>
                        <TableCell>
                          <Skeleton className="h-5 w-28" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-6 w-20" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-5 w-32" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-5 w-40" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-5 w-28" />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : subscribers.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-8 text-center text-muted-foreground"
                      >
                        {t("empty.subscribers")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    subscribers.map(subscriber => (
                      <TableRow key={subscriber.id}>
                        <TableCell>
                          {subscriber.waId ||
                            subscriber.userId ||
                            t("empty.value")}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              subscriber.status ? "default" : "destructive"
                            }
                          >
                            {subscriber.status
                              ? t("status.optedIn")
                              : t("status.optedOut")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {subscriber.source || t("empty.value")}
                        </TableCell>
                        <TableCell>
                          {attributionSummary(subscriber) ||
                            subscriber.metaSignupId ||
                            t("empty.value")}
                        </TableCell>
                        <TableCell>
                          {formatDate(
                            subscriber.eventAt || subscriber.receivedAt
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="bases" className="mt-0 space-y-4">
          <Alert>
            <AlertDescription>{t("bases.defaultHint")}</AlertDescription>
          </Alert>
          <Card>
            <CardHeader>
              <CardTitle>{t("bases.createTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Form {...baseForm}>
                <form
                  onSubmit={baseForm.handleSubmit(createBase)}
                  className="flex gap-2"
                >
                  <FormField
                    control={baseForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormLabel className="sr-only">
                          {t("fields.baseName")}
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder={t("placeholders.baseName")}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" disabled={savingBase}>
                    <Plus className="mr-2 h-4 w-4" />
                    {savingBase
                      ? t("actions.creatingBase")
                      : t("actions.createBase")}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("table.name")}</TableHead>
                    <TableHead>{t("table.metaId")}</TableHead>
                    <TableHead>{t("table.default")}</TableHead>
                    <TableHead className="text-right">
                      {t("table.action")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    Array.from({ length: 3 }, (_, index) => (
                      <TableRow key={index}>
                        <TableCell>
                          <Skeleton className="h-5 w-32" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-5 w-36" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-6 w-20" />
                        </TableCell>
                        <TableCell className="text-right">
                          <Skeleton className="ml-auto h-8 w-24" />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : bases.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-8 text-center text-muted-foreground"
                      >
                        {t("empty.bases")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    bases.map(base => (
                      <TableRow key={base.id}>
                        <TableCell>{base.name}</TableCell>
                        <TableCell>{base.metaCustomerBaseId}</TableCell>
                        <TableCell>
                          {base.isDefault ? (
                            <Badge>{t("status.default")}</Badge>
                          ) : (
                            <Badge variant="outline">{t("status.no")}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {!base.isDefault && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={actionBaseId === base.id}
                              onClick={() => setDefaultBase(base)}
                            >
                              {t("actions.setDefault")}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
