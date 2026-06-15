import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 把 Claude 回复按完整 Markdown 渲染（GFM：表格/删除线/任务列表等） */
export default function Markdown({ content }: { content: string }) {
  return (
    <div className="md-reply">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
