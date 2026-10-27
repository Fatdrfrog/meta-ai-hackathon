"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { zodResolver } from "@hookform/resolvers/zod";
import type { User } from "@supabase/supabase-js";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { updateProfile } from "@/features/panel/settings/profile/actions";
import { createProfileSchema, getAvatarValidationError } from "../schema";

export function ProfileForm({ user }: { user: User | null }) {
  const t = useTranslations("Settings");
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string>();
  const avatarInput = useRef<HTMLInputElement>(null);
  const profileSchema = useMemo(() => createProfileSchema(t), [t]);
  const initialName =
    user?.user_metadata?.full_name || user?.user_metadata?.name || "";

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isDirty },
  } = useForm<{ fullName: string }>({
    resolver: zodResolver(profileSchema),
    defaultValues: { fullName: initialName },
  });
  const fullName = watch("fullName");

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(avatarFile);
    setAvatarPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  const onSubmit = async (data: { fullName: string }) => {
    if (!user || avatarError) return;
    setIsSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("fullName", data.fullName);
      if (avatarFile) formData.append("avatar", avatarFile);
      const result = await updateProfile(
        { error: null, success: false },
        formData
      );
      if (result.error) {
        toast.error(result.error);
      } else if (result.success) {
        toast.success(t("successToast"));
        reset(data);
        setAvatarFile(null);
        if (avatarInput.current) avatarInput.current.value = "";
        router.refresh();
      }
    } catch {
      toast.error(t("profileSaveError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-2xl">
      <Card className="gap-0 shadow-none">
        <CardContent className="p-5 sm:p-6">
          <fieldset disabled={isSubmitting || !user} className="space-y-5">
            <div className="flex items-start gap-4">
              <Avatar className="size-14 border">
                <AvatarImage
                  src={avatarPreview || user?.user_metadata?.avatar_url}
                  alt={fullName}
                />
                <AvatarFallback>
                  {fullName.trim().slice(0, 2).toUpperCase() || "?"}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1 space-y-2">
                <Label htmlFor="avatar">{t("avatarLabel")}</Label>
                <Input
                  ref={avatarInput}
                  id="avatar"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="max-w-sm"
                  aria-invalid={Boolean(avatarError)}
                  aria-describedby="avatar-hint avatar-error"
                  onChange={event => {
                    const file = event.target.files?.[0] ?? null;
                    const error = file ? getAvatarValidationError(file) : null;
                    setAvatarError(error ? t(error) : null);
                    setAvatarFile(error ? null : file);
                  }}
                />
                <p id="avatar-hint" className="text-xs text-muted-foreground">
                  {t("avatarHint")}
                </p>
                {avatarError && (
                  <p
                    id="avatar-error"
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {avatarError}
                  </p>
                )}
              </div>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="fullName">{t("fullNameLabel")}</Label>
                <Input
                  id="fullName"
                  autoComplete="name"
                  placeholder={t("fullNamePlaceholder")}
                  maxLength={100}
                  aria-invalid={Boolean(errors.fullName)}
                  aria-describedby={errors.fullName ? "name-error" : undefined}
                  {...register("fullName")}
                />
                {errors.fullName?.message && (
                  <p
                    id="name-error"
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {errors.fullName.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="profile-email">{t("emailLabel")}</Label>
                <Input
                  id="profile-email"
                  type="email"
                  value={user?.email ?? ""}
                  readOnly
                  className="bg-muted/30 text-muted-foreground"
                />
              </div>
            </div>
          </fieldset>
          {!user && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {t("profileUnavailable")}
            </p>
          )}
        </CardContent>
        <CardFooter className="justify-end border-t px-5 py-3 sm:px-6">
          <Button
            type="submit"
            disabled={
              isSubmitting ||
              !user ||
              Boolean(avatarError) ||
              (!isDirty && !avatarFile)
            }
            size="sm"
          >
            {isSubmitting && <Loader2 className="size-4 animate-spin" />}
            {isSubmitting ? t("saving") : t("saveButton")}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
