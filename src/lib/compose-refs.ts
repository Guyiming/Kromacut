import * as React from "react";

type PossibleRef<T> = React.Ref<T> | undefined;

/**
 * 将给定的 ref 设置为给定的值
 * 此工具处理不同类型的 ref：回调 ref 和 RefObject
 */
function setRef<T>(ref: PossibleRef<T>, value: T)
{
  if (typeof ref === "function")
  {
    return ref(value);
  }

  if (ref !== null && ref !== undefined)
  {
    ref.current = value;
  }
}

/**
 * 用于将多个 ref 组合在一起的工具
 * 接受回调 ref 和 RefObject
 */
function composeRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T>
{
  return (node) =>
  {
    let hasCleanup = false;
    const cleanups = refs.map((ref) =>
    {
      const cleanup = setRef(ref, node);
      if (!hasCleanup && typeof cleanup === "function")
      {
        hasCleanup = true;
      }
      return cleanup;
    });

    // React <19 在回调 ref 返回值时会向控制台记录错误。我们内部不
    // 使用 ref 清理，因此只有在用户的 ref 回调返回值时才会发生这种情况，
    // 这种情况我们只在用户使用 React 19 添加的清理功能时才预期会出现。
    if (hasCleanup)
    {
      return () =>
      {
        for (let i = 0; i < cleanups.length; i++)
        {
          const cleanup = cleanups[i];
          if (typeof cleanup === "function")
          {
            cleanup();
          }
          else
          {
            setRef(refs[i], null);
          }
        }
      };
    }
  };
}

/**
 * 一个组合多个 ref 的自定义 Hook
 * 接受回调 ref 和 RefObject
 */
function useComposedRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T>
{
  // biome-ignore lint/correctness/useExhaustiveDependencies: we want to memoize by all values
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useCallback(composeRefs(...refs), refs);
}

export { composeRefs, useComposedRefs };
