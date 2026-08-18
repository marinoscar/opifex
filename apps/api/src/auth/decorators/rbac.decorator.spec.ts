import 'reflect-metadata';
import { Roles, ROLES_KEY } from './roles.decorator';
import { Permissions, PERMISSIONS_KEY } from './permissions.decorator';

describe('RBAC Decorators', () => {
  describe('@Roles()', () => {
    it('should set metadata with single role', () => {
      @Roles('admin')
      class TestClass {}

      const roles = Reflect.getMetadata(ROLES_KEY, TestClass);
      expect(roles).toEqual(['admin']);
    });

    it('should set metadata with multiple roles', () => {
      @Roles('admin', 'contributor')
      class TestClass {}

      const roles = Reflect.getMetadata(ROLES_KEY, TestClass);
      expect(roles).toEqual(['admin', 'contributor']);
    });

    it('should work on methods', () => {
      class TestClass {
        @Roles('admin')
        testMethod() {}
      }

      const roles = Reflect.getMetadata(ROLES_KEY, TestClass.prototype.testMethod);
      expect(roles).toEqual(['admin']);
    });

    it('should work with multiple roles on methods', () => {
      class TestClass {
        @Roles('admin', 'contributor', 'viewer')
        testMethod() {}
      }

      const roles = Reflect.getMetadata(ROLES_KEY, TestClass.prototype.testMethod);
      expect(roles).toEqual(['admin', 'contributor', 'viewer']);
    });

    it('should set metadata on both class and method independently', () => {
      @Roles('admin')
      class TestClass {
        @Roles('contributor')
        testMethod() {}
      }

      const classRoles = Reflect.getMetadata(ROLES_KEY, TestClass);
      const methodRoles = Reflect.getMetadata(ROLES_KEY, TestClass.prototype.testMethod);

      expect(classRoles).toEqual(['admin']);
      expect(methodRoles).toEqual(['contributor']);
    });

    it('should handle empty roles array', () => {
      // TypeScript won't allow empty array, but runtime could
      const decorator = Roles();
      class TestClass {}
      decorator(TestClass);

      const roles = Reflect.getMetadata(ROLES_KEY, TestClass);
      expect(roles).toEqual([]);
    });
  });

  describe('@Permissions()', () => {
    it('should set metadata with single permission', () => {
      @Permissions('users:read')
      class TestClass {}

      const permissions = Reflect.getMetadata(PERMISSIONS_KEY, TestClass);
      expect(permissions).toEqual(['users:read']);
    });

    it('should set metadata with multiple permissions', () => {
      @Permissions('users:read', 'users:write')
      class TestClass {}

      const permissions = Reflect.getMetadata(PERMISSIONS_KEY, TestClass);
      expect(permissions).toEqual(['users:read', 'users:write']);
    });

    it('should work on methods', () => {
      class TestClass {
        @Permissions('system_settings:write')
        testMethod() {}
      }

      const permissions = Reflect.getMetadata(PERMISSIONS_KEY, TestClass.prototype.testMethod);
      expect(permissions).toEqual(['system_settings:write']);
    });

    it('should work with multiple permissions on methods', () => {
      class TestClass {
        @Permissions('users:read', 'users:write', 'rbac:manage')
        testMethod() {}
      }

      const permissions = Reflect.getMetadata(PERMISSIONS_KEY, TestClass.prototype.testMethod);
      expect(permissions).toEqual(['users:read', 'users:write', 'rbac:manage']);
    });

    it('should set metadata on both class and method independently', () => {
      @Permissions('users:read')
      class TestClass {
        @Permissions('system_settings:write')
        testMethod() {}
      }

      const classPermissions = Reflect.getMetadata(PERMISSIONS_KEY, TestClass);
      const methodPermissions = Reflect.getMetadata(
        PERMISSIONS_KEY,
        TestClass.prototype.testMethod,
      );

      expect(classPermissions).toEqual(['users:read']);
      expect(methodPermissions).toEqual(['system_settings:write']);
    });

    it('should handle empty permissions array', () => {
      // TypeScript won't allow empty array, but runtime could
      const decorator = Permissions();
      class TestClass {}
      decorator(TestClass);

      const permissions = Reflect.getMetadata(PERMISSIONS_KEY, TestClass);
      expect(permissions).toEqual([]);
    });
  });

  describe('Combined Decorators', () => {
    it('should allow both @Roles and @Permissions on same class', () => {
      @Roles('admin')
      @Permissions('users:read')
      class TestClass {}

      const roles = Reflect.getMetadata(ROLES_KEY, TestClass);
      const permissions = Reflect.getMetadata(PERMISSIONS_KEY, TestClass);

      expect(roles).toEqual(['admin']);
      expect(permissions).toEqual(['users:read']);
    });

    it('should allow both @Roles and @Permissions on same method', () => {
      class TestClass {
        @Roles('admin')
        @Permissions('users:write')
        testMethod() {}
      }

      const roles = Reflect.getMetadata(ROLES_KEY, TestClass.prototype.testMethod);
      const permissions = Reflect.getMetadata(PERMISSIONS_KEY, TestClass.prototype.testMethod);

      expect(roles).toEqual(['admin']);
      expect(permissions).toEqual(['users:write']);
    });

    it('should handle different decorators on class vs method', () => {
      @Roles('admin')
      class TestClass {
        @Permissions('system_settings:write')
        testMethod() {}
      }

      const classRoles = Reflect.getMetadata(ROLES_KEY, TestClass);
      const classPermissions = Reflect.getMetadata(PERMISSIONS_KEY, TestClass);
      const methodRoles = Reflect.getMetadata(ROLES_KEY, TestClass.prototype.testMethod);
      const methodPermissions = Reflect.getMetadata(
        PERMISSIONS_KEY,
        TestClass.prototype.testMethod,
      );

      expect(classRoles).toEqual(['admin']);
      expect(classPermissions).toBeUndefined();
      expect(methodRoles).toBeUndefined();
      expect(methodPermissions).toEqual(['system_settings:write']);
    });
  });
});
