# 学习题目勘误接口

仅当前独立账号可读写其学习资料；题型、题号和已有答题/成绩不变。所有接口使用原账号 Bearer session。

- `GET /api/learning/lessons/:lessonId/questions/:questionId`：完整题目与 `revision`，供勘误使用。普通讲义接口仍隐藏未作答答案。
- `PATCH` 同地址：`{revision, question}`。question为完整题目，不含id/revision；选择题包含kind/prompt/options/correctIndex/explanation，问答包含kind/prompt/referenceAnswer/rubric/explanation。有slot的原题可保留原slot。索引从0开始。
- `GET .../questions/:questionId/history?before=<revision>`：历史版本、来源与时间，最多100项，next为下一页游标。
- `POST /api/learning/attempts`：可带`questionRevision`；旧版题目返回409，请刷新后重新作答。旧客户端不传版本仍按当前题目处理。

修改同版本成功后递增revision；过期编辑返回409，错题型、错误索引或空内容返回400。历史题目和原评分不自动重算，之后的作答使用新版。问答判题进行中发生勘误时，该次仍使用已读取的原题快照，并保留对应版本。

主对话的`app_functions`同步提供`learning.question_read`、`learning.question_update`、`learning.question_history`，目录返回严格参数。先读原题、实际核算后修改，不根据其他模型的一段说法自动改动真实学习数据。
