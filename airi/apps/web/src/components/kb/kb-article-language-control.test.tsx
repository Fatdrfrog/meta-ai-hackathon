/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KBArticleLanguageControl } from "./kb-article-language-control";

const push = jest.fn();
const refresh = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => "/panel/w/workspace-1/kb/article-1",
  useRouter: () => ({ push, refresh }),
  useSearchParams: () => new URLSearchParams("view=edit"),
}));

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const messages: Record<string, string> = {
      articleLanguage: "Article language",
      newTranslation: "New translation",
      published: "Published",
      publishedDraft: "Published + draft",
      draft: "Draft",
      languageActions: "Language actions",
      duplicateFrom: "Duplicate from...",
      translateFrom: "Translate from...",
      copyPublicLink: "Copy public link",
      deleteTranslation: "Delete translation",
      createVersion: "Create {language} version",
      createVersionDescription:
        "Start a language draft without changing the workspace UI language.",
      startEmpty: "Start empty",
      startEmptyDesc: "Keep the current title and write new content.",
      copyFromCurrent: "Copy from current language",
      copyFromCurrentDesc: "Duplicate the current draft as a starting point.",
      copyFromDefault: "Copy from default language",
      copyFromDefaultDesc: "Use {language} as the base.",
      translateWithAi: "Translate with AI from current language",
      translateWithAiDesc: "Preserve article formatting and links.",
      deleteTranslationTitle: "Delete translation?",
      deleteTranslationDescription:
        "This removes the {language} article draft, versions, and locale embeddings. The default language stays intact.",
      cancel: "Cancel",
      saveFirst: "Save the article before adding translations",
      updateFailed: "Could not update translation",
      draftReady: "{language} draft is ready",
      translationDeleted: "{language} translation deleted",
      publicLinkCopied: "Public link copied",
      copyPublicLinkFailed: "Could not copy public link",
      deleteFailed: "Could not delete translation",
    };
    const t = (key: string, values?: Record<string, string>) => {
      let message = messages[key] ?? key;
      if (values) {
        for (const [name, value] of Object.entries(values)) {
          message = message.replace(`{${name}}`, value);
        }
      }
      return message;
    };
    t.has = () => true;
    return t;
  },
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock("@/components/ui/popover", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const passthrough = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );

  return {
    Popover: passthrough,
    PopoverTrigger: passthrough,
    PopoverContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

jest.mock("@/components/ui/dropdown-menu", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const passthrough = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );
  const item = ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );

  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuItem: item,
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: passthrough,
    DropdownMenuSubTrigger: item,
    DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

jest.mock("@/components/ui/dialog", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Dialog: ({
      children,
      open,
    }: {
      children: React.ReactNode;
      open?: boolean;
    }) => (open ? <div>{children}</div> : null),
    DialogContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DialogDescription: ({ children }: { children: React.ReactNode }) => (
      <p>{children}</p>
    ),
    DialogHeader: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DialogTitle: ({ children }: { children: React.ReactNode }) => (
      <h2>{children}</h2>
    ),
  };
});

jest.mock("@/components/ui/alert-dialog", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    AlertDialog: ({
      children,
      open,
    }: {
      children: React.ReactNode;
      open?: boolean;
    }) => (open ? <>{children}</> : null),
    AlertDialogAction: ({
      children,
      onClick,
    }: {
      children: React.ReactNode;
      onClick?: () => void;
    }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
      <button type="button">{children}</button>
    ),
    AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
      <p>{children}</p>
    ),
    AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
      <h2>{children}</h2>
    ),
  };
});

function renderControl(
  overrides: Partial<React.ComponentProps<typeof KBArticleLanguageControl>> = {}
) {
  return render(
    <KBArticleLanguageControl
      articleId="article-1"
      currentLocale="en"
      defaultLocale="en"
      localizations={[
        {
          locale: "en",
          status: "published",
          published_at: "2026-05-01T10:00:00.000Z",
          updated_at: null,
          hasDraft: false,
          isDefault: true,
        },
        {
          locale: "ru",
          status: "draft",
          published_at: null,
          updated_at: "2026-05-02T10:00:00.000Z",
          hasDraft: true,
          isDefault: false,
        },
      ]}
      hasLocalization={true}
      {...overrides}
    />
  );
}

describe("KBArticleLanguageControl", () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ success: true }),
    })) as jest.Mock;
  });

  it("switches existing article locales without changing the app locale", async () => {
    const saveBeforeNavigate = jest.fn(async () => true);
    renderControl({ saveBeforeNavigate });

    fireEvent.click(screen.getByRole("button", { name: /Russian Draft/i }));

    await waitFor(() => {
      expect(saveBeforeNavigate).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith(
        "/panel/w/workspace-1/kb/article-1?view=edit&locale=ru"
      );
    });
  });

  it("creates a missing locale from the current language", async () => {
    renderControl();

    fireEvent.click(
      screen.getByRole("button", { name: /Kazakh New translation/i })
    );
    fireEvent.click(screen.getByRole("button", { name: /Start empty/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/kb/article-1/localizations",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            targetLocale: "kz",
            mode: "empty",
            sourceLocale: "en",
          }),
        })
      );
      expect(push).toHaveBeenCalledWith(
        "/panel/w/workspace-1/kb/article-1?view=edit&locale=kz"
      );
    });
  });

  it("does not allow deleting the default language", () => {
    renderControl();

    expect(
      screen.getByRole("button", { name: /Delete translation/i })
    ).toBeDisabled();
  });

  it("keeps publish and unpublish actions out of the in-article language menu", () => {
    renderControl();

    expect(
      screen.queryByRole("button", { name: /Publish English/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Unpublish this language/i })
    ).not.toBeInTheDocument();
  });
});
