package com.lightreader.app;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;

/** Host-side smoke check for formatted DOCX extraction. */
public final class DocxRendererCheck {
    public static void main(String[] args) throws Exception {
        if (args.length < 1) throw new IllegalArgumentException("需要 DOCX 路径");
        DocxRenderer.Content content = DocxRenderer.render(Files.readAllBytes(Path.of(args[0])));
        if (content.text.isEmpty()) throw new AssertionError("DOCX 正文为空");
        if (!content.html.contains("docx-p")) throw new AssertionError("段落 HTML 缺失");
        if (!content.html.contains("docx-table")) throw new AssertionError("表格 HTML 缺失");
        if (!content.html.contains("font-weight:700")) throw new AssertionError("文字样式缺失");
        if (content.html.contains("class=\"docx-p style=\"")) {
            throw new AssertionError("段落 class 属性未闭合");
        }
        if (content.html.contains("<script") || content.html.contains("<iframe")) {
            throw new AssertionError("DOCX HTML 未正确转义");
        }
        if (args.length > 1) {
            String page = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><style>"
                    + "body{margin:0;padding:24px;font-family:system-ui,sans-serif;line-height:1.65}"
                    + ".docx-p{min-height:1em}.docx-list{padding-left:1.35em}.docx-table{width:100%;border-collapse:collapse}"
                    + ".docx-table td{padding:7px;border:1px solid #ccc;vertical-align:top}"
                    + "</style><main id=document>" + content.html + "</main>";
            Files.write(Path.of(args[1]), page.getBytes(StandardCharsets.UTF_8));
        }
        System.out.println("DocxRendererCheck OK: " + content.text.length() + " chars");
    }
}
