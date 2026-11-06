# 卡面设计 · 经典韦特优先

## 默认：经典韦特

按你的选择，默认使用 Pamela Colman Smith / A. E. Waite 的经典人物场景牌面。项目从 Wikimedia Commons 下载完整 78 张，每张先核对元数据中的 Public domain 标记，再保存图片及来源记录。使用 Commons 提供的显示尺寸版本，未改动图像内容；通过界面添加米白边框、中文标题和细金色线条。

来源、作者、文件地址、授权标记及 SHA256：`web/public/cards/classic/sources.json`。下载脚本：`scripts/fetch-classic-cards.py`。代表来源：[愚者](https://commons.wikimedia.org/wiki/File:RWS_Tarot_00_Fool.jpg)、[权杖王牌](https://commons.wikimedia.org/wiki/File:Wands01.jpg)、[星币国王](https://commons.wikimedia.org/wiki/File:Pents14.jpg)。

图鉴可放大查看，下载单张图片并打开来源。图片随网页、桌面和安卓资源打包，运行时没有外部图片依赖。

## 可选：原创现代神秘风

视觉方向：现代神秘风，米白纸张、深绿夜色、旧金细线。每张 300 × 500 的 SVG 都可无损放大，嵌入简体中文和英文牌名；不加载外部字体和第三方图片。

大阿卡纳采用 22 个独立构图：愚者与山崖、魔术师与四元素、女祭司与双柱、恋人与联结、隐者与灯、命运之轮、正义与天平、倒吊人、死神与转化之花、节制的水流、高塔、星星、月亮、太阳、审判与世界之环等。

小阿卡纳使用四种色调：权杖为橄榄绿，圣杯为雾蓝绿，宝剑为石板蓝，星币为苔绿。数字牌的符号数量与牌阶一致；侍从、骑士、王后、国王拥有不同构图，王后使用月相与花枝，国王使用权杖和更具秩序感的纹饰。

牌背由对称星轨、月相、中心星和细点组成。图片均随应用打包，抽牌时无需联网获取牌图。

### 在线参考

查看了 V&A 的 [A history of tarot cards](https://www.vam.ac.uk/articles/tarot-cards)，参考牌组结构、四种花色和传统象征语汇；也检索了 [Wellcome 的 Waite–Smith 馆藏条目](https://wellcomecollection.org/works/vvhjuc5a)。原创主题没有复用这些馆藏页面的图片；它由项目内矢量代码生成，与上面的经典韦特主题分别保存。

### 编辑与导出

- 生成脚本：`scripts/generate-cards.mjs`
- 素材：`web/public/cards/*.svg`
- 清单：`web/public/cards/deck.json`
- 图鉴：应用侧栏「牌面图鉴」，支持查看与下载单张 SVG。

运行 `npm run cards` 可重新生成；`npm run build` 会自动执行。后续更换为其他自有牌组时，可保持相同的文件名与牌 ID，以复用抽牌与历史记录。
