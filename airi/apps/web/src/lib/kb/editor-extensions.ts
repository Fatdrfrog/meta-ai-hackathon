/**
 * KB Editor Extensions
 *
 * Shared TipTap editor configuration for KB article and space editors.
 * Consolidates extension setup to ensure consistency across editors.
 */

import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import LinkExtension from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import {
  BackgroundColor,
  Color,
  FontFamily,
  TextStyle,
} from "@tiptap/extension-text-style";
import Typography from "@tiptap/extension-typography";
import YoutubeExtension from "@tiptap/extension-youtube";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import type { Extensions } from "@tiptap/react";

import { KBGrid, KBGridColumn } from "@/lib/kb/kb-grid-extension";
import { KbChunkPreview } from "@/lib/kb/kb-chunk-preview-extension";
import { KBContainerDeleteShortcuts } from "@/lib/kb/kb-container-delete-shortcuts";
import { KBImageExtension } from "@/lib/kb/kb-image-extension";
import {
  KB_EDITOR_CODE_BLOCK_CLASS_NAME,
  KB_EDITOR_DROP_CURSOR_CLASS_NAME,
  KB_EDITOR_IMAGE_CLASS_NAME,
  KB_EDITOR_INLINE_CODE_CLASS_NAME,
  KB_EDITOR_LINK_CLASS_NAME,
  KB_EDITOR_TABLE_CELL_CLASS_NAME,
  KB_EDITOR_TABLE_CLASS_NAME,
  KB_EDITOR_YOUTUBE_IFRAME_CLASS_NAME,
} from "@/lib/kb/kb-editor-classes";

// Create lowlight instance once
const lowlight = createLowlight(common);

/**
 * Options for creating KB editor extensions
 */
export interface KBEditorOptions {
  /** Placeholder text for empty editor */
  placeholder?: string;
  /** Enable table support (article editor only) */
  enableTables?: boolean;
  /** Minimum editor height in pixels */
  minHeight?: number;
}

/**
 * Default editor options
 */
const defaultOptions: Required<KBEditorOptions> = {
  placeholder: "Start writing...",
  enableTables: false,
  minHeight: 300,
};

/**
 * Create TipTap extensions for KB editor
 *
 * @param options - Editor configuration options
 * @returns Array of TipTap extensions
 */
export function createKBEditorExtensions(
  options?: KBEditorOptions
): Extensions {
  const config = { ...defaultOptions, ...options };

  const extensions: Extensions = [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3],
      },
      dropcursor: {
        color: false,
        width: 3,
        class: KB_EDITOR_DROP_CURSOR_CLASS_NAME,
      },
      code: {
        HTMLAttributes: {
          class: KB_EDITOR_INLINE_CODE_CLASS_NAME,
        },
      },
      codeBlock: false, // Using CodeBlockLowlight instead
      link: false,
      bulletList: {
        keepMarks: true,
        keepAttributes: false,
      },
      orderedList: {
        keepMarks: true,
        keepAttributes: false,
      },
    }),
    // Input rules for smart quotes/dashes in prose only. RAG chunking keys off
    // <h1>–<h3> tags (knowledge-chunkers); Typography does not alter those tags.
    Typography,
    TextStyle,
    Color.configure({
      types: ["textStyle"],
    }),
    BackgroundColor.configure({
      types: ["textStyle"],
    }),
    FontFamily.configure({
      types: ["textStyle"],
    }),
    Placeholder.configure({
      placeholder: config.placeholder,
      showOnlyWhenEditable: true,
    }),
    YoutubeExtension.configure({
      addPasteHandler: true,
      controls: true,
      nocookie: true,
      modestBranding: true,
      allowFullscreen: true,
      width: 960,
      height: 540,
      HTMLAttributes: {
        class: KB_EDITOR_YOUTUBE_IFRAME_CLASS_NAME,
        allow:
          "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
        loading: "lazy",
        referrerpolicy: "strict-origin-when-cross-origin",
      },
    }),
    LinkExtension.configure({
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: "https",
      openOnClick: false,
      HTMLAttributes: {
        class: KB_EDITOR_LINK_CLASS_NAME,
        rel: "noopener noreferrer",
        target: "_blank",
      },
    }),
    KBImageExtension.configure({
      inline: false,
      allowBase64: false,
      HTMLAttributes: {
        class: KB_EDITOR_IMAGE_CLASS_NAME,
        loading: "lazy",
        decoding: "async",
      },
    }),
    CodeBlockLowlight.configure({
      lowlight,
      HTMLAttributes: {
        class: KB_EDITOR_CODE_BLOCK_CLASS_NAME,
      },
    }),
    TextAlign.configure({
      types: ["heading", "paragraph"],
      alignments: ["left", "center", "right", "justify"],
      defaultAlignment: "left",
    }),
    KBContainerDeleteShortcuts,
    KBGrid,
    KBGridColumn,
    KbChunkPreview,
  ];

  // Add table extensions if enabled
  if (config.enableTables) {
    extensions.push(
      Table.configure({
        resizable: true,
        handleWidth: 6,
        cellMinWidth: 96,
        lastColumnResizable: true,
        allowTableNodeSelection: true,
        HTMLAttributes: {
          class: KB_EDITOR_TABLE_CLASS_NAME,
        },
      }),
      TableRow,
      TableHeader,
      TableCell.configure({
        HTMLAttributes: {
          class: KB_EDITOR_TABLE_CELL_CLASS_NAME,
        },
      })
    );
  }

  return extensions;
}
