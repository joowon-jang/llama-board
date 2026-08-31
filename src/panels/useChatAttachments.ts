import { useState } from "react";
import * as api from "../api";
import type { DocumentAttachment, ImageAttachment } from "../chatUtils";

interface UseChatAttachmentsOptions {
  visionReady: boolean;
  /** Mirrors the panel's shared error banner: pass a message to show it, `null` to clear it. */
  setError: (message: string | null) => void;
}

export function useChatAttachments({ visionReady, setError }: UseChatAttachmentsOptions) {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const [attachmentStatus, setAttachmentStatus] = useState<"idle" | "reading" | "ready" | "failed">("idle");

  const addImage = async () => {
    if (!visionReady) {
      setError("Select an mmproj vision sidecar in Models or Tuning before attaching an image.");
      return;
    }
    setAttachmentStatus("reading");
    try {
      const path = await api.pickImage();
      if (!path) { setAttachmentStatus("idle"); return; }
      const dataUrl = await api.readImageData(path);
      setAttachments((current) => current.length >= 4 ? current : [...current, { name: path.split(/[\\/]/).pop() ?? "image", dataUrl }]);
      setAttachmentStatus("ready");
      setError(null);
    } catch (caught) {
      setAttachmentStatus("failed");
      setError(`Image attachment failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  const addDocument = async () => {
    setAttachmentStatus("reading");
    try {
      const path = await api.pickDocument();
      if (!path) { setAttachmentStatus("idle"); return; }
      const text = await api.readDocumentText(path);
      const name = path.split(/[\\/]/).pop() ?? "document";
      setDocuments((current) => current.some((document) => document.path === path) || current.length >= 4
        ? current
        : [...current, { name, path, text }]);
      setAttachmentStatus("ready");
      setError(null);
    } catch (caught) {
      setAttachmentStatus("failed");
      setError(`Document attachment failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  const removeAttachment = (dataUrl: string) => {
    setAttachments((current) => current.filter((item) => item.dataUrl !== dataUrl));
  };

  const removeDocument = (path: string) => {
    setDocuments((current) => current.filter((item) => item.path !== path));
  };

  /** Clears the composer's pending attachments — used after sending and when switching threads. */
  const clearComposerAttachments = () => {
    setAttachments([]);
    setDocuments([]);
    setAttachmentStatus("idle");
  };

  return {
    attachments, documents, attachmentStatus, setAttachments, setDocuments,
    addImage, addDocument, removeAttachment, removeDocument, clearComposerAttachments,
  };
}
