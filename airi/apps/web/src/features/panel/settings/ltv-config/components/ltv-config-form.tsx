"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { ltvConfigPayloadSchema } from "@/lib/ltv-config";

export function createLtvConfigSchema(t: (key: string) => string) {
  return z.object({
    baseValue: z
      .string()
      .min(1, t("ltvBaseValueRequired"))
      .refine(
        val => {
          const num = Number(val);
          return ltvConfigPayloadSchema.shape.baseValue.safeParse(num).success;
        },
        { message: t("ltvMustBePositive") }
      ),
    currency: z
      .string()
      .refine(
        value => ltvConfigPayloadSchema.shape.currency.safeParse(value).success,
        t("ltvCurrencyRequired")
      ),
  });
}

type LTVConfigFormValues = z.infer<ReturnType<typeof createLtvConfigSchema>>;

interface LTVConfigFormProps {
  workspaceId: string;
  initialValues: {
    baseValue: number | null;
    currency: string;
  };
}

const COMMON_CURRENCIES = [
  { code: "USD", name: "US Dollar ($)" },
  { code: "EUR", name: "Euro (€)" },
  { code: "GBP", name: "British Pound (£)" },
  { code: "KZT", name: "Kazakhstani Tenge (₸)" },
  { code: "RUB", name: "Russian Ruble (₽)" },
  { code: "UZS", name: "Uzbekistani Som" },
  { code: "UAH", name: "Ukrainian Hryvnia (₴)" },
  { code: "PLN", name: "Polish Złoty (zł)" },
  { code: "TRY", name: "Turkish Lira (₺)" },
  { code: "CNY", name: "Chinese Yuan (¥)" },
  { code: "JPY", name: "Japanese Yen (¥)" },
  { code: "INR", name: "Indian Rupee (₹)" },
];

export function LTVConfigForm({
  workspaceId,
  initialValues,
}: LTVConfigFormProps) {
  const t = useTranslations("Settings");
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const ltvConfigSchema = useMemo(() => createLtvConfigSchema(t), [t]);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isDirty },
  } = useForm<LTVConfigFormValues>({
    resolver: zodResolver(ltvConfigSchema),
    defaultValues: {
      baseValue: initialValues.baseValue?.toString() || "",
      currency: initialValues.currency || "USD",
    },
  });

  const selectedCurrency = watch("currency");

  const onSubmit = async (data: LTVConfigFormValues) => {
    setIsSubmitting(true);

    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/ltv-config`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            baseValue: Number(data.baseValue),
            currency: data.currency,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok || result.success !== true) {
        toast.error(t("ltvUpdateFailed"));
      } else {
        toast.success(t("ltvUpdateSuccess"));
        reset(data);
        router.refresh();
      }
    } catch {
      toast.error(t("ltvUpdateFailed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Card>
        <fieldset disabled={isSubmitting} className="min-w-0">
          <CardContent className="grid gap-5 pt-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="baseValue">
                {t("ltvBaseValueLabel")}{" "}
                <span className="text-muted-foreground">
                  {t("ltvBaseValuePerMonth")}
                </span>
              </Label>
              <Input
                id="baseValue"
                type="number"
                step="0.01"
                min="0"
                placeholder={t("ltvBaseValuePlaceholder")}
                aria-invalid={!!errors.baseValue}
                aria-describedby="ltv-base-hint"
                {...register("baseValue")}
              />
              {errors.baseValue?.message && (
                <p className="text-sm text-destructive">
                  {String(errors.baseValue.message)}
                </p>
              )}
              <p id="ltv-base-hint" className="text-xs text-muted-foreground">
                {t("ltvBaseValueHint")}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="currency">{t("ltvCurrencyLabel")}</Label>
              <Select
                disabled={isSubmitting}
                value={selectedCurrency}
                onValueChange={value =>
                  setValue("currency", value, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger
                  id="currency"
                  className="w-full"
                  aria-invalid={!!errors.currency}
                >
                  <SelectValue placeholder={t("ltvSelectCurrency")} />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_CURRENCIES.map(currency => (
                    <SelectItem key={currency.code} value={currency.code}>
                      {currency.code}
                    </SelectItem>
                  ))}
                  {!COMMON_CURRENCIES.some(
                    currency => currency.code === selectedCurrency
                  ) &&
                    /^[A-Z]{3}$/.test(selectedCurrency) && (
                      <SelectItem value={selectedCurrency}>
                        {selectedCurrency}
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
              {errors.currency?.message && (
                <p className="text-sm text-destructive">
                  {String(errors.currency.message)}
                </p>
              )}
            </div>

            <p className="text-xs text-muted-foreground sm:col-span-2">
              {t("ltvEstimateHint")}
            </p>
          </CardContent>
          <CardFooter className="border-t px-6 py-4">
            <Button type="submit" disabled={isSubmitting || !isDirty}>
              {isSubmitting && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {isSubmitting ? t("saving") : t("ltvSaveButton")}
            </Button>
          </CardFooter>
        </fieldset>
      </Card>
    </form>
  );
}
