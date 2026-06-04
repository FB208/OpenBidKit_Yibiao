
今天开一个新的系列，之前还是习惯性按照古法技术博客的思路，分享方案+代码。但是vibe coding时代，我已经完全转向opencode + codex。
越来越觉得“code is cheap show me the prompt”不再是一个梗。

本系列分享我在vibe coding AI标书智能体的时候，到底是如何prompt的。

希望大家读完之后，能够学会搭建AI智能体，让AI正式成为你的生产力工具。

也接受批评和指正，欢迎讨论。

易标投标工具箱，项目源码、提示词已在 GitHub 完全开源：https://github.com/FB208/OpenBidKit_Yibiao

## 你不需要RAG
一提到知识库，很多人第一反应就是RAG，之前我也是，早在gpt-3.5时代，我就研究过RAG